/**
 * The dual-review coordinator: the single owner of one plan's review lifecycle.
 *
 * It composes the earlier modules into one receipt-bound round. It never edits
 * the plan, never writes a durable record itself (lib/review-store.js owns
 * persistence and its promise chain), never starts a model directly
 * (lib/review-transport.js owns the two native activations), never serves plan
 * bytes (lib/review-input.js owns bound delivery), and never decides
 * convergence: lib/review-state.js is the only state machine, and only its
 * explicit approval predicate can mark a record approved.
 *
 * Invariants enforced here:
 *   - lint runs before any activation; a lint failure charges no budget;
 *   - the pending requirement is persisted before the first start;
 *   - exactly one round is active; duplicate/concurrent starts reuse it;
 *   - the snapshot, prompt, role/config/policy hashes, both activations,
 *     coverage and structured verdicts become one atomic terminal record;
 *   - an exact live-source (instruction-hash) change stales both lanes;
 *     after a planner fix, the next round takes a new snapshot and new
 *     round/launch/child identities;
 *   - budget exhaustion is decided by the reducer; an uncalled request never
 *     consumes budget and cancelling accepted calls never refunds them;
 *   - an unbound native run identity is surfaced as a human/new-record path,
 *     never forged into a terminal lane.
 *
 * Runtime handles live in this process only. A recovered record without them
 * is reported as WAIT_UNAVAILABLE/RUN_UNBOUND; the durable store decides what
 * survives a restart. Native subagent/start events may arrive after the
 * transport returns, so an injected waitForRuns({handle, childIds, round})
 * seam may supply the two real run identities; without it the coordinator
 * fails closed instead of inventing one.
 *
 * @module dsh-ulw-plan/review-coordinator
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReviewArtifact } from './review-artifact.js'
import { parseReviewConfig } from './review-config.js'
import {
  REVIEW_DIAGNOSTIC_CODES,
  REVIEW_LANES,
  ReviewContractError,
  assertPlainJson,
  buildReviewPrompt,
  parseReviewRequest,
} from './review-protocol.js'
import { lintPlan } from './review-lint.js'
import { REVIEW_CAPTURE_TOOL, REVIEW_INPUT_TOOL, REVIEW_READ_TOOLS } from './review-policy.js'
import { REVIEW_LANE_PRESETS, reviewerPersonaPrefix } from './review-presets.js'
import { evaluateApproval, reviewPolicyComponents } from './review-state.js'
import { canonicalReviewIdentity } from './review-store.js'
import { preflightReviewRoutes, startReviewActivations } from './review-transport.js'

/** Coordinator-only outcomes on top of the protocol's diagnostic vocabulary. */
export const REVIEW_COORDINATOR_CODES = Object.freeze([
  ...REVIEW_DIAGNOSTIC_CODES,
  'LINT_FAILED', 'INVALID_ARTIFACT', 'INVALID_TRANSITION', 'PERSIST_FAILED',
  'STORE_UNAVAILABLE', 'NOT_REQUIRED', 'NOT_STARTED', 'WAIT_UNAVAILABLE',
  'RUN_UNBOUND', 'CANCEL_UNBOUND', 'INPUT_BIND_FAILED', 'LAUNCH_FAILED',
  'UNKNOWN_ROUND', 'INVALID_IDENTITY',
])

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const DIGEST = /^[a-f0-9]{64}$/
const STARTABLE = Object.freeze(['required', 'preparing', 'changes_requested', 'stale'])
const LANE_FAILURES = Object.freeze(['max_tokens', 'timeout', 'error', 'refused', 'interrupted'])
const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const isDigest = value => typeof value === 'string' && DIGEST.test(value)
const isIdentifier = value => typeof value === 'string' && ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && IDENTIFIER.test(value)
const messageOf = error => (error instanceof Error ? error.message : String(error))
const hashText = value => createHash('sha256').update(value, 'utf8').digest('hex')
const clonePlain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const diagnostic = (code, path, message) => ({ code, path, message })
const errorCode = (error, fallback = 'INVALID_REQUEST') => {
  const code = error?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : fallback
}
const errorDiagnostics = error => {
  if (Array.isArray(error?.diagnostics) && error.diagnostics.length > 0) {
    return error.diagnostics.map(entry => ({
      code: typeof entry?.code === 'string' ? entry.code : 'INVALID_REQUEST',
      path: typeof entry?.path === 'string' ? entry.path : '$',
      message: String(entry?.message ?? ''),
    }))
  }
  return [diagnostic(errorCode(error), typeof error?.path === 'string' ? error.path : '$', messageOf(error) || 'Invalid review operation')]
}
const approvalOf = record => {
  if (!record) return { approved: false, reasons: ['NO_RECORD'], roundId: null, receipts: null }
  try {
    const value = evaluateApproval(record)
    return {
      approved: value.approved === true,
      reasons: [...value.reasons],
      roundId: value.approved ? value.roundId : null,
      receipts: value.approved ? value.receipts : null,
    }
  } catch {
    return { approved: false, reasons: ['INVALID_RECORD'], roundId: null, receipts: null }
  }
}
const roundById = (record, roundId) => record.rounds.find(round => round.roundId === roundId)
const selectRound = record => {
  if (!record || !Array.isArray(record.rounds) || record.rounds.length === 0) return null
  if (record.activeRoundId !== null) return roundById(record, record.activeRoundId) ?? null
  if (record.approvedRoundId !== null) return roundById(record, record.approvedRoundId) ?? null
  return record.rounds.at(-1) ?? null
}
const canAffordAnotherRound = record => record.budget.consumed + 2 <= record.budget.authorized
const nextActionFor = record => {
  if (!record) return 'require'
  switch (record.state) {
    case 'required':
    case 'preparing':
      return 'start'
    case 'in_flight': {
      const round = selectRound(record)
      const bound = round !== null && REVIEW_LANES.every(lane => round.lanes[lane].runId !== null)
      return bound ? 'wait' : 'new_record'
    }
    case 'changes_requested':
      return canAffordAnotherRound(record) ? 'fix_plan' : 'new_record'
    case 'stale':
      return canAffordAnotherRound(record) ? 'start' : 'new_record'
    case 'approved':
      return null
    case 'inconclusive':
    case 'cancelled':
    case 'stopped':
      return 'new_record'
    default:
      return 'status'
  }
}
const failureReason = error => {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (LANE_FAILURES.includes(code)) return code
  if (error?.name === 'AbortError' || code === 'CANCELLED' || code === 'ABORT_ERR') return 'interrupted'
  return 'error'
}

/** Trusted default scope: the fixed input/tool surface plus both lane presets. */
function defaultScopeSha256() {
  return hashText(JSON.stringify({
    version: 1,
    input: REVIEW_INPUT_TOOL,
    reads: [...REVIEW_READ_TOOLS],
    capture: REVIEW_CAPTURE_TOOL,
    presets: REVIEW_LANES.map(lane => REVIEW_LANE_PRESETS[lane]),
  }))
}
/** Trusted default role: the two package-owned reviewer contracts. */
function defaultRoleSha256() {
  return hashText(JSON.stringify(REVIEW_LANES.map(lane => reviewerPersonaPrefix(lane))))
}

/** One request-level reservation mirroring the budget the reducer already charged.
 * reserve() is what review-transport.js calls; settle() moves any un-released
 * calls into "accepted", so an accepted activation is never refunded.
 */
function createReservation(record) {
  const capacity = record.budget.authorized - record.budget.consumed + 2
  const state = { capacity, reserved: 0, accepted: 0, released: 0 }
  const budget = {
    reserve(count) {
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new ReviewContractError('BUDGET_EXHAUSTED', '$.budget', 'Expected a positive call reservation')
      }
      if (state.reserved + state.accepted + count > state.capacity) {
        throw new ReviewContractError('BUDGET_EXHAUSTED', '$.budget', 'No review calls remain for this round')
      }
      state.reserved += count
      let open = true
      return {
        release(amount = 1) {
          if (!open) return
          open = false
          const released = Math.min(Number.isSafeInteger(amount) && amount > 0 ? amount : 0, count)
          state.reserved -= released
          state.released += released
        },
      }
    },
  }
  return {
    budget,
    settle() {
      state.accepted += state.reserved
      state.reserved = 0
    },
    snapshot() {
      return { capacity: state.capacity, reserved: state.reserved, accepted: state.accepted, released: state.released }
    },
  }
}

function assertCoordinatorOptions(options) {
  if (!isPlainObject(options)) throw new TypeError('createReviewCoordinator requires an options object')
  if (typeof options.workspace !== 'string' || !options.workspace.startsWith('/')) {
    throw new TypeError('createReviewCoordinator requires a canonical absolute workspace')
  }
  if (!options.store || typeof options.store.status !== 'function' || typeof options.store.create !== 'function' || typeof options.store.apply !== 'function') {
    throw new TypeError('createReviewCoordinator requires the durable review store')
  }
  if (!options.input || typeof options.input.coverageOf !== 'function' ||
      (typeof options.input.bindReviewInput !== 'function' && typeof options.input.bind !== 'function')) {
    throw new TypeError('createReviewCoordinator requires the bound review-input service')
  }
  if (typeof options.capture !== 'function' && options.capture !== undefined) {
    throw new TypeError('createReviewCoordinator capture must be a function')
  }
  if (typeof options.startActivations !== 'function' && options.startActivations !== undefined) {
    throw new TypeError('createReviewCoordinator startActivations must be a function')
  }
  if (typeof options.preflight !== 'function' && options.preflight !== undefined) {
    throw new TypeError('createReviewCoordinator preflight must be a function')
  }
}

/**
 * Create the per-plan review coordinator.
 * Options: workspace plus store, input, and optional capture, preflight,
 * startActivations, config (object or getter), scopeSha256, roleSha256, ids,
 * subagents, llm, parent and signal.
 */
export function createReviewCoordinator(options = {}) {
  assertCoordinatorOptions(options)
  const workspace = options.workspace
  const store = options.store
  const input = options.input
  const capture = options.capture ?? (request => createReviewArtifact(request))
  const preflight = options.preflight ?? (request => preflightReviewRoutes(request))
  const startActivations = options.startActivations ?? startReviewActivations
  const ids = isPlainObject(options.ids) ? options.ids : {}
  const rawRoundId = typeof ids.roundId === 'function' ? ids.roundId : () => 'round-' + randomUUID()
  const rawLaunchId = typeof ids.launchId === 'function' ? ids.launchId : () => 'launch-' + randomUUID()
  const rawChildId = typeof ids.childId === 'function' ? ids.childId : lane => 'review-' + lane + '-' + randomUUID()

  const roundTargets = new Map()
  const runtime = new Map()
  const configOf = () => (typeof options.config === 'function' ? options.config() : options.config)

  function remember(record) {
    if (!record || !Array.isArray(record.rounds)) return
    for (const round of record.rounds) {
      roundTargets.set(round.roundId, { workspace: record.workspace, target: record.target })
    }
  }

  function policyContext() {
    try {
      const raw = configOf()
      const config = parseReviewConfig(raw === undefined ? {} : raw)
      const scopeSha256 = options.scopeSha256 ?? defaultScopeSha256()
      const roleSha256 = options.roleSha256 ?? defaultRoleSha256()
      const policy = reviewPolicyComponents({ scopeSha256, roleSha256, config: raw === undefined ? {} : raw })
      return { ok: true, config, policy }
    } catch (error) {
      return { ok: false, diagnostics: errorDiagnostics(error) }
    }
  }

  function inputCoverageOf(childId) {
    if (typeof childId !== 'string' || childId.length === 0) return null
    try {
      const raw = input.coverageOf(childId)
      if (!raw) return null
      return {
        complete: raw.complete === true,
        pages: Number.isSafeInteger(raw.pages) ? raw.pages : 0,
        deliveredBytes: Number.isSafeInteger(raw.deliveredBytes) ? raw.deliveredBytes : 0,
        totalBytes: Number.isSafeInteger(raw.totalBytes) ? raw.totalBytes : 0,
        planSha256: isDigest(raw.sha256) ? raw.sha256 : null,
        instructionSha256: isDigest(raw.instructionSha256) ? raw.instructionSha256 : null,
      }
    } catch {
      return null
    }
  }

  function laneView(round, lane) {
    const state = round.lanes[lane]
    const receipt = state.receipt ? clonePlain(state.receipt) : null
    const coverage = receipt?.coverage ?? inputCoverageOf(state.childId)
    return {
      lane,
      status: state.status,
      childId: state.childId,
      runId: state.runId,
      verdict: state.result?.verdict ?? null,
      reason: state.reason,
      receipt,
      coverage: coverage ? clonePlain(coverage) : null,
    }
  }

  function budgetView(record) {
    if (!record) return null
    const { authorized, consumed, exhausted } = record.budget
    return { authorized, consumed, remaining: authorized - consumed, exhausted }
  }

  function resourcesView(record) {
    const round = selectRound(record)
    const handle = round ? runtime.get(round.roundId) : undefined
    const activations = round
      ? REVIEW_LANES.map(lane => {
        const state = round.lanes[lane]
        const activation = handle?.handle?.lanes?.find?.(entry => entry.lane === lane)
        return {
          lane,
          childId: state.childId,
          runId: state.runId,
          status: state.status,
          messageId: typeof activation?.messageId === 'string' ? activation.messageId : null,
          disposed: handle?.disposed === true,
        }
      })
      : []
    let lifecycle = null
    try { lifecycle = handle?.handle?.runs?.snapshot?.() ?? null } catch { lifecycle = null }
    const inputLanes = round
      ? REVIEW_LANES.map(lane => {
        const childId = round.lanes[lane].childId
        const coverage = inputCoverageOf(childId)
        return { lane, childId, bound: coverage !== null, coverage }
      })
      : []
    let storeHealth
    try { storeHealth = typeof store.health === 'function' ? store.health() : { ok: true } } catch (error) {
      storeHealth = { ok: false, code: errorCode(error, 'STORE_UNAVAILABLE') }
    }
    return {
      activeRoundId: record?.activeRoundId ?? null,
      activations,
      lifecycle,
      input: { bound: inputLanes.length > 0 && inputLanes.every(entry => entry.bound), lanes: inputLanes },
      store: storeHealth,
      budget: budgetView(record),
    }
  }

  function makeResult(record, fields = {}) {
    const approval = approvalOf(record)
    const round = selectRound(record)
    const lanes = {}
    if (round) for (const lane of REVIEW_LANES) lanes[lane] = laneView(round, lane)
    const result = {
      ok: fields.ok !== false,
      action: fields.action ?? null,
      outcome: fields.outcome ?? record?.state ?? null,
      code: fields.code ?? null,
      diagnostics: [...(fields.diagnostics ?? [])],
      state: record?.state ?? null,
      revision: record?.revision ?? null,
      requirement: record
        ? {
          exists: true,
          required: record.required === true,
          state: record.state,
          revision: record.revision,
          workspace: record.workspace,
          target: record.target,
          rounds: record.rounds.length,
          ledgerOpen: record.ledger.filter(entry => entry.status !== 'closed').length,
        }
        : { exists: false },
      round: round
        ? {
          roundId: round.roundId,
          launchId: round.launchId,
          number: round.number,
          state: round.state,
          source: clonePlain(round.source),
          policy: clonePlain(round.policy),
          lanes,
        }
        : null,
      lanes: round ? lanes : null,
      approval: { approved: approval.approved, reasons: approval.reasons, roundId: approval.roundId },
      approved: approval.approved,
      budget: budgetView(record),
      resources: resourcesView(record),
      nextAction: fields.nextAction === undefined ? nextActionFor(record) : fields.nextAction,
      reused: fields.reused === true,
      record: record ?? null,
    }
    if (fields.lint !== undefined) result.lint = fields.lint
    return result
  }

  function failureResult(action, fields) {
    return makeResult(fields.record ?? null, { ...fields, action, ok: false })
  }

  function prepare(action, request) {
    try {
      if (request !== undefined && request !== null) {
        assertPlainJson(request, 'INVALID_REQUEST')
        if (!isPlainObject(request)) {
          return { ok: false, failure: failureResult(action, { code: 'INVALID_REQUEST', outcome: 'invalid_request', diagnostics: [diagnostic('INVALID_REQUEST', '$', 'Expected a plain request object')] }) }
        }
        if (Object.hasOwn(request, 'action') && request.action !== action) {
          return { ok: false, failure: failureResult(action, { code: 'INVALID_REQUEST', outcome: 'invalid_request', diagnostics: [diagnostic('INVALID_REQUEST', '$.action', 'Request action does not match the invoked coordinator method')] }) }
        }
      }
      const raw = request === undefined || request === null ? { action } : { ...request, action }
      const parsed = parseReviewRequest(raw)
      let target
      if (Object.hasOwn(parsed, 'target')) target = parsed.target
      else {
        const known = roundTargets.get(parsed.roundId)
        if (!known) {
          return { ok: false, failure: failureResult(action, { code: 'UNKNOWN_ROUND', outcome: 'invalid_request', diagnostics: [diagnostic('UNKNOWN_ROUND', '$.roundId', 'No round with that identity is known to this coordinator')] }) }
        }
        target = known.target
      }
      const canonical = canonicalReviewIdentity({ workspace, target })
      return { ok: true, parsed, identity: { workspace: canonical.workspace, target: canonical.target }, target: canonical.target }
    } catch (error) {
      return {
        ok: false,
        failure: failureResult(action, {
          code: errorCode(error),
          outcome: 'invalid_request',
          diagnostics: errorDiagnostics(error),
        }),
      }
    }
  }

  function load(identity) {
    let out
    try { out = store.status(identity) } catch (error) {
      return { ok: false, code: 'STORE_UNAVAILABLE', diagnostics: errorDiagnostics(error) }
    }
    if (!out || out.ok !== true) {
      return {
        ok: false,
        code: typeof out?.code === 'string' ? out.code : 'STORE_UNAVAILABLE',
        diagnostics: Array.isArray(out?.diagnostics) && out.diagnostics.length ? out.diagnostics : [diagnostic('STORE_UNAVAILABLE', '$', 'The review store refused the read')],
      }
    }
    if (out.record) remember(out.record)
    return { ok: true, exists: out.exists === true, record: out.record ?? null }
  }

  async function applyEvent(identity, event) {
    try {
      const out = await store.apply(identity, event)
      if (out?.record) remember(out.record)
      return out ?? { ok: false, code: 'PERSIST_FAILED', outcome: 'rejected', diagnostics: [diagnostic('PERSIST_FAILED', '$', 'The review store returned no result')] }
    } catch (error) {
      return { ok: false, code: errorCode(error, 'PERSIST_FAILED'), outcome: 'rejected', record: null, diagnostics: errorDiagnostics(error) }
    }
  }

  function storeFailure(action, out, extra = {}) {
    const code = typeof out?.code === 'string' ? out.code : out?.diagnostics?.[0]?.code ?? 'PERSIST_FAILED'
    return failureResult(action, {
      code,
      outcome: out?.outcome ?? 'rejected',
      record: out?.record ?? extra.record ?? null,
      diagnostics: out?.diagnostics ?? [diagnostic(code, '$', 'The review store refused the operation')],
      nextAction: extra.nextAction,
    })
  }

  async function ensureRequirement(identity, policy, config) {
    const status = load(identity)
    if (!status.ok) {
      return {
        ok: false,
        failure: failureResult('start', {
          code: status.code,
          outcome: 'start_rejected',
          diagnostics: status.diagnostics,
        }),
      }
    }
    if (!status.exists) {
      let out
      try {
        out = await store.create(identity, { required: true, policy, budget: { authorized: config.callBudget } })
      } catch (error) {
        return { ok: false, failure: failureResult('start', { code: errorCode(error, 'PERSIST_FAILED'), outcome: 'start_rejected', diagnostics: errorDiagnostics(error) }) }
      }
      if (out?.record) remember(out.record)
      if (!out?.ok) return { ok: false, failure: storeFailure('start', out) }
      if (out.record.required !== true) {
        const applied = await applyEvent(identity, { type: 'require' })
        if (!applied.ok) return { ok: false, failure: storeFailure('start', applied, { record: out.record }) }
        return { ok: true, record: applied.record }
      }
      return { ok: true, record: out.record }
    }
    if (status.record.required === true) return { ok: true, record: status.record }
    const applied = await applyEvent(identity, { type: 'require' })
    if (!applied.ok) return { ok: false, failure: storeFailure('start', applied, { record: status.record }) }
    return { ok: true, record: applied.record }
  }

  function artifactShapeError(artifact, target) {
    if (!artifact || typeof artifact !== 'object') return 'Expected one captured plan snapshot'
    if (!isDigest(artifact.sha256) || !isDigest(artifact.instructionSha256)) return 'The snapshot exposes no raw SHA-256 identities'
    if (!Number.isSafeInteger(artifact.totalBytes) || artifact.totalBytes <= 0) return 'The snapshot has no plan bytes'
    if (!artifact.source || artifact.source.workspace !== workspace || artifact.source.relativePath !== target) {
      return 'The snapshot source does not match the bound plan'
    }
    let bytes
    try { bytes = artifact.bytes } catch { return 'The snapshot exposes no readable bytes' }
    if (!Buffer.isBuffer(bytes)) return 'The snapshot bytes are not a Buffer'
    if (bytes.length !== artifact.totalBytes) return 'The snapshot byte length is inconsistent'
    return null
  }

  const footprint = { roundIds: new Set(), launchIds: new Set(), childIds: new Set() }
  function refreshFootprint(record) {
    for (const round of record.rounds) {
      footprint.roundIds.add(round.roundId)
      footprint.launchIds.add(round.launchId)
      for (const lane of REVIEW_LANES) footprint.childIds.add(round.lanes[lane].childId)
    }
  }
  function freshId(factory, used, label) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let value
      try { value = factory(label) } catch { value = undefined }
      if (isIdentifier(value) && !used.has(value)) return value
    }
    throw new ReviewContractError('INVALID_REQUEST', '$.' + label, 'The identity source did not produce a fresh canonical identity')
  }

  function promptLedger(ledger) {
    return ledger.map(entry => ({
      id: entry.id,
      eligibility: entry.eligibility,
      location: { taskId: entry.location.taskId, isId: entry.location.isId, gapId: entry.location.gapId },
      evidence: entry.evidence.map(item => ({ path: item.path, line: item.line, endLine: item.endLine })),
      remediation: entry.remediation,
      status: entry.status,
    }))
  }

  function buildPrompts(details) {
    const accepted = promptLedger(details.ledger)
    const prompts = {}
    for (const lane of REVIEW_LANES) {
      prompts[lane] = [{
        type: 'text',
        text: buildReviewPrompt({
          artifact: { workspace, relativePath: details.target, planSha256: details.artifact.sha256 },
          round: { roundId: details.roundId, launchId: details.launchId },
          ledger: accepted,
          lane,
        }),
      }]
    }
    return prompts
  }

  function collectRunIds(handle, observed, childIds) {
    const collected = {}
    let snapshot = null
    try { snapshot = handle?.runs?.snapshot?.() ?? null } catch { snapshot = null }
    for (const lane of REVIEW_LANES) {
      const candidates = [
        handle?.runIds?.[lane],
        handle?.lanes?.find?.(entry => entry.lane === lane)?.runId,
        observed?.get(lane),
        snapshot?.lanes?.find?.(entry => entry.lane === lane)?.runId,
      ]
      const found = candidates.find(value => isIdentifier(value))
      if (found !== undefined) collected[lane] = found
    }
    return collected
  }

  /** Run ids may arrive from the handle, from observed lifecycle starts, or
   * from an injected native waitForRuns seam (the real Host emits subagent/start
   * asynchronously). Missing identities are never invented.
   */
  async function resolveRunIds(handle, observed, childIds, round) {
    const collected = collectRunIds(handle, observed, childIds)
    if (REVIEW_LANES.every(lane => collected[lane] !== undefined)) return collected
    if (typeof options.waitForRuns !== 'function') return collected
    try {
      const extra = await options.waitForRuns({ handle, childIds, observed, round })
      if (extra && typeof extra === 'object') {
        for (const lane of REVIEW_LANES) {
          if (collected[lane] === undefined && isIdentifier(extra[lane])) collected[lane] = extra[lane]
        }
      }
    } catch {
      // The missing run identity is the reportable failure, not the wait error.
    }
    const after = collectRunIds(handle, observed, childIds)
    for (const lane of REVIEW_LANES) {
      if (collected[lane] === undefined && after[lane] !== undefined) collected[lane] = after[lane]
    }
    return collected
  }

  async function bindRuns(identity, round, runIds) {
    let record = null
    let allBound = true
    const diagnostics = []
    for (const lane of REVIEW_LANES) {
      const status = load(identity)
      if (!status.ok || !status.record) {
        return { ok: false, allBound: false, record: record ?? status.record ?? null, diagnostics: status.diagnostics ?? [] }
      }
      record = status.record
      const current = roundById(record, round.roundId)
      if (!current) return { ok: false, allBound: false, record, diagnostics: [diagnostic('STALE_ARTIFACT', '$.roundId', 'The started round is missing from the durable record')] }
      const laneState = current.lanes[lane]
      const runId = runIds?.[lane]
      if (laneState.runId !== null) {
        if (runId !== undefined && runId !== laneState.runId) {
          return { ok: false, allBound: false, record, diagnostics: [diagnostic('STALE_ARTIFACT', '$.runId', 'The lane is already bound to a different run identity')] }
        }
        continue
      }
      if (runId === undefined) {
        allBound = false
        continue
      }
      const out = await applyEvent(identity, {
        type: 'bind_run',
        roundId: round.roundId,
        launchId: round.launchId,
        lane,
        childId: laneState.childId,
        runId,
      })
      if (out.record) record = out.record
      if (!out.ok) {
        diagnostics.push(...(out.diagnostics ?? [diagnostic(out.code ?? 'PERSIST_FAILED', '$.runId', 'The run binding was refused')]))
        return { ok: false, allBound: false, record, diagnostics }
      }
    }
    const final = load(identity)
    if (final.ok && final.record) record = final.record
    return { ok: true, allBound, record, diagnostics }
  }

  async function failLanes(identity, round, stopReason) {
    let record = null
    for (const lane of REVIEW_LANES) {
      const status = load(identity)
      if (!status.ok || !status.record) return { ok: false, record: record ?? null, diagnostics: status.diagnostics ?? [] }
      record = status.record
      const current = roundById(record, round.roundId)
      const laneState = current?.lanes?.[lane]
      if (!laneState || laneState.status !== 'in_flight') continue
      if (laneState.runId === null) {
        return { ok: false, record, diagnostics: [diagnostic('RUN_UNBOUND', '$.runId', 'A lane without a bound run identity cannot become terminal')] }
      }
      const out = await applyEvent(identity, {
        type: 'lane_failure',
        roundId: round.roundId,
        launchId: round.launchId,
        lane,
        childId: laneState.childId,
        runId: laneState.runId,
        stopReason,
      })
      if (out.record) record = out.record
      if (!out.ok) return { ok: false, record, diagnostics: out.diagnostics ?? [] }
    }
    const final = load(identity)
    if (final.ok && final.record) record = final.record
    return { ok: true, record, diagnostics: [] }
  }

  async function disposeRuntime(handle) {
    if (!handle || handle.disposed === true) return { diagnostics: [] }
    handle.disposed = true
    const diagnostics = []
    try { handle.handle?.releaseObservers?.() } catch (error) {
      diagnostics.push(diagnostic(errorCode(error, 'DISPOSE_FAILED'), '$', 'Lifecycle observer release failed: ' + messageOf(error)))
    }
    try { await handle.handle?.dispose?.() } catch (error) {
      diagnostics.push(diagnostic(errorCode(error, 'DISPOSE_FAILED'), '$', 'Activation disposal failed: ' + messageOf(error)))
    }
    return { diagnostics }
  }

  async function disposeRoundById(roundId) {
    const handle = runtime.get(roundId)
    if (handle) return disposeRuntime(handle)
    return { diagnostics: [] }
  }

  function bindInputFor(lane, childId, artifact) {
    if (typeof input.bindReviewInput === 'function') input.bindReviewInput({ childId, lane, artifact })
    else input.bind({ childId, lane, artifact })
    if (!inputCoverageOf(childId)) {
      throw new ReviewContractError('INPUT_BIND_FAILED', '$.childId', 'The input service reported no coverage binding for ' + childId)
    }
  }

  // -------------------------------------------------------------------------
  // public actions
  // -------------------------------------------------------------------------

  async function requireReview(request) {
    const prepared = prepare('require', request)
    if (!prepared.ok) return prepared.failure
    const { identity } = prepared
    const policyCtx = policyContext()
    if (!policyCtx.ok) {
      return failureResult('require', { code: policyCtx.diagnostics[0]?.code ?? 'INVALID_CONFIG', outcome: 'require_rejected', diagnostics: policyCtx.diagnostics })
    }
    if (policyCtx.config.enabled !== true) {
      return failureResult('require', {
        code: 'CAPABILITY_UNAVAILABLE',
        outcome: 'require_rejected',
        diagnostics: [diagnostic('CAPABILITY_UNAVAILABLE', '$.enabled', 'Enhanced review is disabled or lacks explicit authorization')],
      })
    }
    const status = load(identity)
    if (!status.ok) return failureResult('require', { code: status.code, outcome: 'require_rejected', diagnostics: status.diagnostics })
    if (status.exists && status.record.required === true) {
      return makeResult(status.record, { action: 'require', outcome: 'required_already' })
    }
    if (!status.exists) {
      let out
      try {
        out = await store.create(identity, {
          required: true,
          policy: policyCtx.policy,
          budget: { authorized: policyCtx.config.callBudget },
        })
      } catch (error) {
        return failureResult('require', { code: errorCode(error, 'PERSIST_FAILED'), outcome: 'require_rejected', diagnostics: errorDiagnostics(error) })
      }
      if (out?.record) remember(out.record)
      if (!out?.ok) return storeFailure('require', out)
      if (out.record.required !== true) {
        const applied = await applyEvent(identity, { type: 'require' })
        if (!applied.ok) return storeFailure('require', applied, { record: out.record })
        return makeResult(applied.record, { action: 'require', outcome: 'required' })
      }
      return makeResult(out.record, { action: 'require', outcome: 'required' })
    }
    const applied = await applyEvent(identity, { type: 'require' })
    if (!applied.ok) return storeFailure('require', applied, { record: status.record })
    return makeResult(applied.record, { action: 'require', outcome: 'required' })
  }

  async function start(request) {
    const prepared = prepare('start', request)
    if (!prepared.ok) return prepared.failure
    const { identity, target } = prepared
    const policyCtx = policyContext()
    if (!policyCtx.ok) {
      return failureResult('start', { code: policyCtx.diagnostics[0]?.code ?? 'INVALID_CONFIG', outcome: 'start_rejected', diagnostics: policyCtx.diagnostics })
    }
    const { config, policy } = policyCtx
    if (config.enabled !== true) {
      return failureResult('start', {
        code: 'CAPABILITY_UNAVAILABLE',
        outcome: 'start_rejected',
        diagnostics: [diagnostic('CAPABILITY_UNAVAILABLE', '$.enabled', 'Enhanced review is disabled or lacks explicit authorization')],
      })
    }
    const ensured = await ensureRequirement(identity, policy, config)
    if (!ensured.ok) return ensured.failure
    let record = ensured.record
    refreshFootprint(record)

    if (record.policy.policySha256 !== policy.policySha256) {
      const priorActiveId = record.activeRoundId
      const out = await applyEvent(identity, { type: 'policy_change', policy })
      if (out.record) record = out.record
      if (!out.ok) return storeFailure('start', out, { record })
      if (out.outcome === 'stale') {
        await disposeRoundById(priorActiveId)
        return failureResult('start', { code: 'STALE_ARTIFACT', outcome: 'stale', record, diagnostics: out.diagnostics ?? [] })
      }
    }

    let artifact
    try {
      artifact = await capture({ workspace, target })
    } catch (error) {
      return failureResult('start', {
        code: errorCode(error, 'STALE_ARTIFACT'),
        outcome: 'start_rejected',
        record,
        diagnostics: errorDiagnostics(error),
      })
    }
    const shapeError = artifactShapeError(artifact, target)
    if (shapeError) {
      return failureResult('start', {
        code: 'INVALID_ARTIFACT',
        outcome: 'start_rejected',
        record,
        diagnostics: [diagnostic('INVALID_ARTIFACT', '$.artifact', shapeError)],
      })
    }
    const source = { planSha256: artifact.sha256, instructionSha256: artifact.instructionSha256 }
    const priorActiveId = record.activeRoundId
    const sourceOut = await applyEvent(identity, { type: 'source_change', source })
    if (sourceOut.record) record = sourceOut.record
    if (!sourceOut.ok) return storeFailure('start', sourceOut, { record })
    if (sourceOut.outcome === 'stale') {
      await disposeRoundById(priorActiveId)
      return failureResult('start', { code: 'STALE_ARTIFACT', outcome: 'stale', record, diagnostics: sourceOut.diagnostics ?? [] })
    }

    let lint
    try {
      lint = lintPlan({ content: Buffer.from(artifact.bytes), path: target })
    } catch (error) {
      return failureResult('start', { code: 'INVALID_ARTIFACT', outcome: 'start_rejected', record, diagnostics: [diagnostic('INVALID_ARTIFACT', '$.artifact', messageOf(error))] })
    }
    if (!lint.valid) {
      return failureResult('start', {
        code: 'LINT_FAILED',
        outcome: 'start_rejected',
        record,
        diagnostics: lint.diagnostics
          .filter(entry => entry.severity === 'error')
          .map(entry => diagnostic(entry.code, 'line ' + entry.line, entry.message)),
        lint,
      })
    }

    if (record.activeRoundId !== null) {
      const active = roundById(record, record.activeRoundId)
      if (active && active.source.instructionSha256 === source.instructionSha256 && active.policy.policySha256 === policy.policySha256) {
        return makeResult(record, { action: 'start', outcome: 'existing_round', reused: true })
      }
      return failureResult('start', {
        code: 'STALE_ARTIFACT',
        outcome: 'stale',
        record,
        diagnostics: [diagnostic('STALE_ARTIFACT', '$.roundId', 'The active round does not match the live source')],
      })
    }

    const prior = [...record.rounds].reverse().find(round =>
      round.source.instructionSha256 === source.instructionSha256 && round.policy.policySha256 === policy.policySha256)
    if (prior) {
      return makeResult(record, { action: 'start', outcome: 'existing_round', reused: true })
    }
    if (!STARTABLE.includes(record.state)) {
      return failureResult('start', {
        code: 'INVALID_TRANSITION',
        outcome: 'start_rejected',
        record,
        diagnostics: [diagnostic('INVALID_TRANSITION', '$.state', 'Review is terminal in state ' + record.state + '; a new record is required')],
      })
    }

    try {
      await preflight({ llm: options.llm, config, signal: options.signal })
    } catch (error) {
      return failureResult('start', {
        code: errorCode(error, 'ROUTE_UNAUTHORIZED'),
        outcome: 'start_rejected',
        record,
        diagnostics: errorDiagnostics(error),
      })
    }

    let roundId, launchId, childIds, prompts
    try {
      roundId = freshId(rawRoundId, footprint.roundIds, 'roundId')
      launchId = freshId(rawLaunchId, footprint.launchIds, 'launchId')
      childIds = {}
      for (const lane of REVIEW_LANES) {
        childIds[lane] = freshId(() => rawChildId(lane), footprint.childIds, 'childId')
        footprint.childIds.add(childIds[lane])
      }
      footprint.roundIds.add(roundId)
      footprint.launchIds.add(launchId)
      prompts = buildPrompts({ artifact, roundId, launchId, target, ledger: record.ledger })
    } catch (error) {
      return failureResult('start', { code: errorCode(error, 'INVALID_REQUEST'), outcome: 'start_rejected', record, diagnostics: errorDiagnostics(error) })
    }

    const startEvent = {
      type: 'start',
      roundId,
      launchId,
      source,
      policy,
      lanes: {
        practical: { childId: childIds.practical },
        adversarial: { childId: childIds.adversarial },
      },
    }
    const startOut = await applyEvent(identity, startEvent)
    const current = startOut.record ?? record
    if (current) record = current
    if (!startOut.ok) {
      if (record.activeRoundId !== null) {
        const active = roundById(record, record.activeRoundId)
        if (active && active.source.instructionSha256 === source.instructionSha256 && active.policy.policySha256 === policy.policySha256) {
          return makeResult(record, { action: 'start', outcome: 'existing_round', reused: true })
        }
      }
      return storeFailure('start', startOut, { record })
    }
    if (startOut.outcome === 'stopped_budget' || startOut.outcome === 'stopped') {
      return failureResult('start', {
        code: startOut.outcome === 'stopped_budget' ? 'BUDGET_EXHAUSTED' : 'STALE_ARTIFACT',
        outcome: startOut.outcome,
        record,
        diagnostics: startOut.diagnostics ?? [],
        nextAction: 'new_record',
      })
    }
    if (startOut.outcome !== 'started') {
      if (startOut.outcome === 'existing_round') {
        return makeResult(record, { action: 'start', outcome: 'existing_round', reused: true })
      }
      return failureResult('start', {
        code: startOut.diagnostics?.[0]?.code ?? 'INVALID_TRANSITION',
        outcome: startOut.outcome ?? 'start_rejected',
        record,
        diagnostics: startOut.diagnostics ?? [],
      })
    }
    const startedRound = roundById(record, roundId)
    const reservation = createReservation(record)
    const observed = new Map()
    const events = {
      onStart(info) {
        if (!info || !isIdentifier(info.id) || !isIdentifier(info.runId)) return
        const lane = REVIEW_LANES.find(candidate => childIds[candidate] === info.id)
        if (lane !== undefined && !observed.has(lane)) observed.set(lane, info.runId)
      },
      onEnd() {
        // Native lifecycle is observation only; an end event never decides a verdict.
      },
    }

    let handle
    try {
      handle = await startActivations({
        subagents: options.subagents,
        llm: options.llm,
        config,
        parent: options.parent,
        prompts,
        childIds,
        signal: options.signal ?? new AbortController().signal,
        budget: reservation.budget,
        events,
      })
    } catch (error) {
      reservation.settle()
      const runIds = collectRunIds(null, observed, childIds)
      const bound = await bindRuns(identity, startedRound, runIds)
      let terminal = bound.record ?? record
      let nextAction = 'new_record'
      if (bound.allBound) {
        const failed = await failLanes(identity, startedRound, 'error')
        terminal = failed.record ?? terminal
        nextAction = nextActionFor(terminal)
      }
      return failureResult('start', {
        code: errorCode(error, 'LAUNCH_FAILED'),
        outcome: 'start_failed',
        record: terminal,
        diagnostics: [...errorDiagnostics(error), ...(bound.diagnostics ?? [])],
        nextAction,
      })
    }

    reservation.settle()
    const runIds = await resolveRunIds(handle, observed, childIds, startedRound)
    const bound = await bindRuns(identity, startedRound, runIds)
    if (bound.record) record = bound.record
    if (!bound.ok || !bound.allBound) {
      const disposal = await disposeRuntime({ handle, disposed: false })
      return failureResult('start', {
        code: 'RUN_UNBOUND',
        outcome: 'start_failed',
        record,
        diagnostics: [
          diagnostic('RUN_UNBOUND', '$.runId', 'The activation exposed no native run identity for both lanes; no terminal state is forged'),
          ...(bound.diagnostics ?? []),
          ...disposal.diagnostics,
        ],
        nextAction: 'new_record',
      })
    }

    const liveRound = roundById(record, roundId)
    try {
      for (const lane of REVIEW_LANES) bindInputFor(lane, liveRound.lanes[lane].childId, artifact)
    } catch (error) {
      const failed = await failLanes(identity, liveRound, 'error')
      const terminal = failed.record ?? record
      await disposeRuntime({ handle, disposed: false })
      return failureResult('start', {
        code: errorCode(error, 'INPUT_BIND_FAILED'),
        outcome: 'start_failed',
        record: terminal,
        diagnostics: errorDiagnostics(error),
        nextAction: nextActionFor(terminal),
      })
    }

    runtime.set(roundId, {
      target,
      identity,
      roundId,
      launchId,
      artifact,
      handle,
      childIds,
      observed,
      disposed: false,
      waitPromise: null,
      reservation,
    })
    return makeResult(record, { action: 'start', outcome: 'started' })
  }

  async function wait(request) {
    const prepared = prepare('wait', request)
    if (!prepared.ok) return prepared.failure
    const { identity } = prepared
    const loaded = load(identity)
    if (!loaded.ok) return failureResult('wait', { code: loaded.code, outcome: 'wait_failed', diagnostics: loaded.diagnostics })
    if (!loaded.exists) {
      return failureResult('wait', {
        code: 'NOT_REQUIRED',
        outcome: 'not_started',
        diagnostics: [diagnostic('NOT_REQUIRED', '$', 'No review requirement exists for this plan')],
        nextAction: 'require',
      })
    }
    const record = loaded.record
    if (record.activeRoundId === null) return makeResult(record, { action: 'wait', outcome: record.state })
    const runtimeHandle = runtime.get(record.activeRoundId)
    if (!runtimeHandle) {
      return failureResult('wait', {
        code: 'WAIT_UNAVAILABLE',
        outcome: 'wait_unavailable',
        record,
        diagnostics: [diagnostic('WAIT_UNAVAILABLE', '$', 'The active round has no runtime handles in this process; a human/new record is required')],
        nextAction: 'new_record',
      })
    }
    if (runtimeHandle.waitPromise) return runtimeHandle.waitPromise
    const promise = performWait(runtimeHandle)
    runtimeHandle.waitPromise = promise
    promise.then(result => {
      if (!result?.ok) runtimeHandle.waitPromise = null
    }, () => { runtimeHandle.waitPromise = null })
    return promise
  }

  async function performWait(runtimeHandle) {
    const { identity, target, roundId, launchId } = runtimeHandle
    const policyCtx = policyContext()
    let loaded = load(identity)
    if (!loaded.ok) return failureResult('wait', { code: loaded.code, outcome: 'wait_failed', diagnostics: loaded.diagnostics })
    let record = loaded.record
    if (!record || record.activeRoundId !== roundId) return makeResult(record, { action: 'wait', outcome: record?.state ?? 'cancelled' })

    if (policyCtx.ok && record.policy.policySha256 !== policyCtx.policy.policySha256) {
      const out = await applyEvent(identity, { type: 'policy_change', policy: policyCtx.policy })
      if (out.record) record = out.record
      if (!out.ok) return storeFailure('wait', out, { record })
      if (out.outcome === 'stale') {
        const disposal = await disposeRuntime(runtimeHandle)
        return makeResult(record, { action: 'wait', outcome: 'stale', diagnostics: [...(out.diagnostics ?? []), ...disposal.diagnostics] })
      }
    }

    let artifact
    try {
      artifact = await capture({ workspace, target })
    } catch (error) {
      return failureResult('wait', {
        code: errorCode(error, 'STALE_ARTIFACT'),
        outcome: 'stale',
        record,
        diagnostics: [...errorDiagnostics(error), diagnostic('STALE_ARTIFACT', '$.source', 'The live source could not be revalidated; approval is withheld')],
        nextAction: 'new_record',
      })
    }
    const shapeError = artifactShapeError(artifact, target)
    if (shapeError) {
      return failureResult('wait', {
        code: 'INVALID_ARTIFACT',
        outcome: 'stale',
        record,
        diagnostics: [diagnostic('INVALID_ARTIFACT', '$.artifact', shapeError)],
        nextAction: 'new_record',
      })
    }
    const source = { planSha256: artifact.sha256, instructionSha256: artifact.instructionSha256 }
    const sourceOut = await applyEvent(identity, { type: 'source_change', source })
    if (sourceOut.record) record = sourceOut.record
    if (!sourceOut.ok) return storeFailure('wait', sourceOut, { record })
    if (sourceOut.outcome === 'stale') {
      const disposal = await disposeRuntime(runtimeHandle)
      return makeResult(record, { action: 'wait', outcome: 'stale', diagnostics: [...(sourceOut.diagnostics ?? []), ...disposal.diagnostics] })
    }
    if (!record || record.activeRoundId !== roundId) return makeResult(record, { action: 'wait', outcome: record?.state ?? 'cancelled' })

    const lanes = REVIEW_LANES.map(lane => {
      const activation = runtimeHandle.handle?.lanes?.find?.(entry => entry.lane === lane)
      const promise = activation && activation.result && typeof activation.result.then === 'function'
        ? Promise.resolve(activation.result)
        : Promise.reject(Object.assign(new Error('The activation exposed no result promise'), { code: 'error' }))
      promise.catch(() => {})
      return { lane, promise }
    })
    const settled = await Promise.allSettled(lanes.map(entry => entry.promise))

    loaded = load(identity)
    if (!loaded.ok) return failureResult('wait', { code: loaded.code, outcome: 'wait_failed', diagnostics: loaded.diagnostics })
    record = loaded.record
    if (!record || record.activeRoundId !== roundId) return makeResult(record, { action: 'wait', outcome: record?.state ?? 'cancelled' })

    const observed = await resolveRunIds(runtimeHandle.handle, runtimeHandle.observed, runtimeHandle.childIds, roundById(record, roundId))
    const bound = await bindRuns(identity, roundById(record, roundId), observed)
    if (bound.record) record = bound.record
    if (!bound.allBound) {
      const disposal = await disposeRuntime(runtimeHandle)
      return failureResult('wait', {
        code: 'RUN_UNBOUND',
        outcome: 'wait_unavailable',
        record,
        diagnostics: [
          diagnostic('RUN_UNBOUND', '$.runId', 'The lanes have no bound native run identity; a late completion cannot be received'),
          ...(bound.diagnostics ?? []),
          ...disposal.diagnostics,
        ],
        nextAction: 'new_record',
      })
    }

    for (let index = 0; index < lanes.length; index += 1) {
      const lane = lanes[index].lane
      loaded = load(identity)
      if (!loaded.ok) return failureResult('wait', { code: loaded.code, outcome: 'wait_failed', diagnostics: loaded.diagnostics })
      record = loaded.record
      if (!record || record.activeRoundId !== roundId) return makeResult(record, { action: 'wait', outcome: record?.state ?? 'cancelled' })
      const round = roundById(record, roundId)
      const laneState = round.lanes[lane]
      if (laneState.status !== 'in_flight') continue
      let out
      if (settled[index].status === 'rejected') {
        out = await applyEvent(identity, {
          type: 'lane_failure',
          roundId,
          launchId,
          lane,
          childId: laneState.childId,
          runId: laneState.runId,
          stopReason: failureReason(settled[index].reason),
        })
      } else {
        const raw = inputCoverageOf(laneState.childId)
        const coverage = {
          complete: raw?.complete === true,
          pages: raw?.pages ?? 0,
          deliveredBytes: raw?.deliveredBytes ?? 0,
          totalBytes: raw?.totalBytes ?? 0,
          planSha256: raw?.planSha256 ?? round.source.planSha256,
          instructionSha256: raw?.instructionSha256 ?? round.source.instructionSha256,
        }
        out = await applyEvent(identity, {
          type: 'lane_result',
          roundId,
          launchId,
          lane,
          childId: laneState.childId,
          runId: laneState.runId,
          coverage,
          result: settled[index].value,
        })
      }
      if (out.record) record = out.record
      if (!out.ok) {
        return failureResult('wait', {
          code: out.code ?? out.diagnostics?.[0]?.code ?? 'PERSIST_FAILED',
          outcome: 'wait_failed',
          record,
          diagnostics: out.diagnostics ?? [],
        })
      }
    }

    loaded = load(identity)
    if (!loaded.ok) return failureResult('wait', { code: loaded.code, outcome: 'wait_failed', diagnostics: loaded.diagnostics })
    record = loaded.record
    if (record.activeRoundId === null) {
      const disposal = await disposeRuntime(runtimeHandle)
      return makeResult(record, { action: 'wait', outcome: record.state, diagnostics: disposal.diagnostics })
    }
    return makeResult(record, { action: 'wait', outcome: 'in_flight' })
  }

  async function cancel(request) {
    const prepared = prepare('cancel', request)
    if (!prepared.ok) return prepared.failure
    const { identity } = prepared
    const loaded = load(identity)
    if (!loaded.ok) return failureResult('cancel', { code: loaded.code, outcome: 'cancel_failed', diagnostics: loaded.diagnostics })
    if (!loaded.exists) {
      return failureResult('cancel', {
        code: 'NOT_REQUIRED',
        outcome: 'cancel_rejected',
        diagnostics: [diagnostic('NOT_REQUIRED', '$', 'No review requirement exists for this plan')],
        nextAction: 'require',
      })
    }
    let record = loaded.record
    let round = record.activeRoundId === null ? null : roundById(record, record.activeRoundId)
    if (!round) {
      return failureResult('cancel', {
        code: 'INVALID_TRANSITION',
        outcome: 'cancel_rejected',
        record,
        diagnostics: [diagnostic('INVALID_TRANSITION', '$.state', 'There is no active round to cancel')],
      })
    }
    const runtimeHandle = runtime.get(round.roundId)
    if (runtimeHandle) {
      const observed = await resolveRunIds(runtimeHandle.handle, runtimeHandle.observed, runtimeHandle.childIds, round)
      const bound = await bindRuns(identity, round, observed)
      if (bound.record) record = bound.record
      round = record.activeRoundId === null ? null : roundById(record, record.activeRoundId)
    }
    if (!round) return makeResult(record, { action: 'cancel', outcome: record.state })
    const unbound = REVIEW_LANES.some(lane => round.lanes[lane].status === 'in_flight' && round.lanes[lane].runId === null)
    if (unbound) {
      const disposal = runtimeHandle ? await disposeRuntime(runtimeHandle) : { diagnostics: [] }
      return failureResult('cancel', {
        code: 'CANCEL_UNBOUND',
        outcome: 'cancel_rejected',
        record,
        diagnostics: [
          diagnostic('CANCEL_UNBOUND', '$.runId', 'A cancelling lane needs a bound run identity; a human/new record is required'),
          ...disposal.diagnostics,
        ],
        nextAction: 'new_record',
      })
    }
    const out = await applyEvent(identity, { type: 'cancel' })
    if (out.record) record = out.record
    if (!out.ok) return storeFailure('cancel', out, { record })
    const disposal = runtimeHandle ? await disposeRuntime(runtimeHandle) : { diagnostics: [] }
    return makeResult(record, {
      action: 'cancel',
      outcome: 'cancelled',
      diagnostics: [...(out.diagnostics ?? []), ...disposal.diagnostics],
    })
  }

  async function status(request) {
    const prepared = prepare('status', request)
    if (!prepared.ok) return prepared.failure
    const { identity } = prepared
    const loaded = load(identity)
    if (!loaded.ok) return failureResult('status', { code: loaded.code, outcome: 'status_failed', diagnostics: loaded.diagnostics })
    if (!loaded.exists) return makeResult(null, { action: 'status', outcome: 'missing', nextAction: 'require' })
    return makeResult(loaded.record, { action: 'status', outcome: loaded.record.state })
  }

  return Object.freeze({ require: requireReview, start, wait, status, cancel })
}
