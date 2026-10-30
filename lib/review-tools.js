/**
 * The Host-facing review entrypoints: one model tool and the slash command.
 *
 * The root plugin contribution (skills, consult, mode, projection, plan guard)
 * is registered independently of this module. This module adds:
 *
 *   - ulw_review: one model tool whose only parameters are an action and a
 *     target/round selector. It never accepts a verdict, approval or note.
 *   - the enhanced /ulw-review command router: it resolves one plan target,
 *     registers the requirement, accepts one round asynchronously, and returns
 *     a receipt that says plainly this is NOT a completed review. The existing
 *     agent.followup bridge then asks the conversation to poll wait/status.
 *
 * Enhanced assembly is optional. Every enhanced service (subagents,
 * agentPresets, llm, storage) is detected through ctx.get(); when one is
 * missing the original Host surfaces keep working and both enhanced
 * entrypoints answer with a specific capability diagnostic. There is no inline
 * approval fallback: the legacy contract injection in lib/commands.js is only
 * reachable when a caller composes that module without a router, which the
 * shipped entrypoint never does.
 *
 * Disposal is ordered by ownership: stop admission, cancel/observe reviewers
 * and persist the terminal record, close the store unit, then release the tool
 * guards and presets. Every step is idempotent and bounded by event-loop turns
 * (never a wall-clock sleep) so a hung reviewer can still not wedge unload.
 *
 * @module dsh-ulw-plan/review-tools
 */
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createReviewCoordinator } from './review-coordinator.js'
import { installReviewInput } from './review-input.js'
import { installReviewPolicy } from './review-policy.js'
import { REVIEW_LANE_PRESETS, registerReviewPresets } from './review-presets.js'
import { REVIEW_LANES, parseReviewRequest } from './review-protocol.js'
import { openReviewStore } from './review-store.js'
import { startReviewActivations } from './review-transport.js'

/** The one model-facing review tool. */
export const REVIEW_TOOL = 'ulw_review'
/** Every dispatchable action; they mirror the coordinator one-to-one. */
export const REVIEW_ACTIONS = Object.freeze(['require', 'start', 'wait', 'status', 'cancel'])
/** Services that must all be present for the enhanced assembly. */
export const REVIEW_ENHANCED_SERVICES = Object.freeze(['subagents', 'agentPresets', 'llm', 'storage'])
/** Effect label owned by lib/index.js. */
export const REVIEW_ENTRY_EFFECT = 'dsh-ulw-plan:review'
/** States in which a round or requirement is still an accepted, live review. */
export const REVIEW_LIVE_STATES = Object.freeze(['required', 'preparing', 'in_flight'])
/** States that can never become a live acceptance again on the same identity. */
export const REVIEW_TERMINAL_STATES = Object.freeze(['approved', 'changes_requested', 'inconclusive', 'stale', 'cancelled', 'stopped'])
/** The documented recovery is a new identity; the plugin never reopens a record. */
export const REVIEW_RECOVERY_ROUTE = 'new_target_or_human_reset'

/** Event-loop turns used to bound cleanup and late native lifecycle waits. */
const DISPOSE_TURNS = 64
const RUN_WAIT_TURNS = 24

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}
const safeInt = (value) => (Number.isSafeInteger(value) ? value : 0)
const textOf = (value) => (typeof value === 'string' ? value : '')
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))
const errorCode = (error, fallback = 'INVALID_REQUEST') => {
  const code = error?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : fallback
}
const diagnostic = (code, path, message) => ({ code, path, message })
const normalizeDiagnostics = (list) => {
  if (!Array.isArray(list)) return []
  return list.filter(isPlainObject).map((entry) => ({
    code: textOf(entry.code) || 'INVALID_REQUEST',
    path: textOf(entry.path) || '$',
    message: textOf(entry.message),
  }))
}
const errorDiagnostics = (error) => {
  if (Array.isArray(error?.diagnostics) && error.diagnostics.length > 0) return normalizeDiagnostics(error.diagnostics)
  return [diagnostic(errorCode(error), '$', errorMessage(error) || 'Invalid review operation')]
}
const turnsLater = (count) => {
  let pending = Promise.resolve()
  for (let index = 0; index < count; index += 1) {
    pending = pending.then(() => new Promise((resolve) => setImmediate(resolve)))
  }
  return pending
}
/** Await a value for at most a fixed number of event-loop turns. Never a timer. */
function bounded(value, turns = DISPOSE_TURNS) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    Promise.resolve(value).then(
      (result) => finish({ value: result }),
      (error) => finish({ error }),
    )
    turnsLater(turns).then(() => finish({ timedOut: true }))
  })
}
/** Race one coordinator promise against the caller signal without leaking a listener. */
function raceSignal(value, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') {
    return Promise.resolve(value).then((result) => ({ value: result }), (error) => { throw error })
  }
  if (signal.aborted) {
    Promise.resolve(value).catch(() => {})
    return Promise.resolve({ aborted: true })
  }
  return new Promise((resolve, reject) => {
    let done = false
    const cleanup = () => { try { signal.removeEventListener('abort', onAbort) } catch { /* already gone */ } }
    const onAbort = () => {
      if (done) return
      done = true
      cleanup()
      resolve({ aborted: true })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(value).then(
      (result) => {
        if (done) return
        done = true
        cleanup()
        resolve({ value: result })
      },
      (error) => {
        if (done) return
        done = true
        cleanup()
        reject(error)
      },
    )
  })
}

/** Read the raw review config out of the plugin config envelope. */
export function reviewConfigOf(config) {
  if (!isPlainObject(config)) return {}
  return isPlainObject(config.review) ? config.review : {}
}

/** Specific capability snapshot. Missing services are named, never guessed. */
export function capabilityStatus(missing = [], detail = '') {
  const names = [...missing].filter((name) => typeof name === 'string')
  if (names.length === 0) {
    return deepFreeze({ available: true, code: '', missing: [], reason: '', detail: '' })
  }
  return deepFreeze({
    available: false,
    code: 'CAPABILITY_UNAVAILABLE',
    missing: names,
    reason: 'MISSING_' + names.map((name) => name.toUpperCase()).join('_'),
    detail: detail || 'Enhanced dual review needs the Host services ' + names.join(', ') + '; the ordinary /ulw-mode, /ulw-consult, /ulw-plan and /ulw-execute surfaces remain independent.',
  })
}

function capabilityFromError(error, fallback = 'CAPABILITY_UNAVAILABLE') {
  return {
    available: false,
    code: errorCode(error, fallback),
    missing: [],
    reason: 'ASSEMBLY_FAILED',
    detail: errorMessage(error) || 'The enhanced review assembly failed',
  }
}

/** Name every enhanced service currently absent from one context. */
export function enhancedMissing(ctx) {
  const missing = []
  for (const name of REVIEW_ENHANCED_SERVICES) {
    let value
    try { value = ctx.get(name) } catch { value = undefined }
    if (value === undefined || value === null) missing.push(name)
  }
  return missing
}

const readyCapability = () => ({ available: true, code: '', missing: [], reason: '', detail: '' })
const pendingCapability = () => ({
  available: false, code: 'CAPABILITY_UNAVAILABLE', missing: [], reason: 'REVIEW_ASSEMBLY_PENDING',
  detail: 'Enhanced review is still assembling; retry after the Host finishes loading.',
})
const shuttingDownCapability = () => ({
  available: false, code: 'CAPABILITY_UNAVAILABLE', missing: [], reason: 'REVIEW_SHUTTING_DOWN',
  detail: 'The enhanced review entrypoint is disposing; no review operation is admitted.',
})

function buildRecovery({ nextAction, state, target }) {
  if (nextAction !== 'new_record') return { required: false, route: '', detail: '' }
  return {
    required: true,
    route: REVIEW_RECOVERY_ROUTE,
    detail:
      'The durable review record for ' + (target || 'this target') + ' is create-once and terminal (state ' + (state || 'unknown') + '); ' +
      'it is never reopened. Review the plan under a new canonical .dsh/ulw/plans/<new-slug>.md target, or reset the stored review record outside this plugin.',
  }
}

/**
 * Normalize one coordinator result into the model-facing envelope.
 * Acceptance and completion are derived from durable state, never result.ok:
 * a terminal stopped/cancelled record can answer ok:true with outcome
 * existing_round and that is explicitly not an acceptance.
 */
export function buildReviewEnvelope(result, options = {}) {
  const capability = deepFreeze({ ...readyCapability(), ...(isPlainObject(options.capability) ? options.capability : {}) })
  const value = isPlainObject(result) ? result : null
  const action = textOf(options.action) || textOf(value?.action)
  const state = textOf(value?.state)
  const outcome = textOf(value?.outcome) || (capability.available ? 'invalid_request' : 'unavailable')
  const ok = value !== null && value.ok !== false
  const code = textOf(value?.code)
  const nextAction = textOf(value?.nextAction)
  const approval = isPlainObject(value?.approval) ? value.approval : null
  const approved = value !== null && ok && state === 'approved' && value.approved === true && approval?.approved === true
  let phase
  if (!capability.available) phase = 'unavailable'
  else if (value === null) phase = 'invalid'
  else if (!ok) phase = 'rejected'
  else if (REVIEW_LIVE_STATES.includes(state)) phase = 'live'
  else if (REVIEW_TERMINAL_STATES.includes(state)) phase = 'terminal'
  else phase = 'missing'
  const round = isPlainObject(value?.round) ? value.round : null
  // A live state is only an acceptance when the coordinator still owns it: an
  // in-flight round without both native run identities is a dead round whose
  // nextAction is already new_record (a failed half-start must never read as
  // an accepted review), and any new_record nextAction is terminal history.
  const roundUnbound = round !== null && REVIEW_LANES.some((lane) => textOf(value?.lanes?.[lane]?.runId) === '')
  const accepted = phase === 'live' && nextAction !== 'new_record' && !roundUnbound
  const completed = phase === 'terminal' && approved
  const requirement = isPlainObject(value?.requirement) ? value.requirement : null
  const roundSource = isPlainObject(round?.source) ? round.source : {}
  const lanes = []
  for (const laneName of REVIEW_LANES) {
    const lane = isPlainObject(value?.lanes?.[laneName]) ? value.lanes[laneName] : {}
    const coverage = isPlainObject(lane.coverage) ? lane.coverage : {}
    lanes.push({
      lane: laneName,
      status: textOf(lane.status),
      childId: textOf(lane.childId),
      runId: textOf(lane.runId),
      verdict: textOf(lane.verdict),
      complete: coverage.complete === true,
      deliveredBytes: safeInt(coverage.deliveredBytes),
      totalBytes: safeInt(coverage.totalBytes),
    })
  }
  const budget = isPlainObject(value?.budget) ? value.budget : {}
  const target = textOf(requirement?.target)
  return {
    ok,
    action,
    phase,
    outcome,
    accepted,
    completed,
    terminal: phase === 'terminal',
    approved,
    reused: value !== null && value.reused === true,
    state,
    code,
    nextAction,
    revision: safeInt(value?.revision),
    roundId: textOf(round?.roundId),
    launchId: textOf(round?.launchId),
    round: round === null ? null : {
      roundId: textOf(round.roundId),
      launchId: textOf(round.launchId),
      number: safeInt(round.number),
      state: textOf(round.state),
      planSha256: textOf(roundSource.planSha256),
      instructionSha256: textOf(roundSource.instructionSha256),
    },
    lanes,
    requirement: {
      exists: requirement !== null && requirement.exists !== false,
      required: requirement?.required === true,
      state: textOf(requirement?.state),
      revision: safeInt(requirement?.revision),
      rounds: safeInt(requirement?.rounds),
      target,
    },
    budget: {
      authorized: safeInt(budget.authorized),
      consumed: safeInt(budget.consumed),
      remaining: safeInt(budget.remaining),
    },
    capability,
    recovery: buildRecovery({ nextAction, state, target }),
    diagnostics: normalizeDiagnostics(value?.diagnostics),
    detail: capability.available
      ? 'state ' + (state || 'none') + ', outcome ' + outcome
      : capability.detail,
  }
}

/** Render one envelope for the model. States accepted/completed explicitly. */
export function renderReviewEnvelope(value) {
  const envelope = isPlainObject(value) ? value : {}
  const lines = []
  lines.push('ulw_review ' + (envelope.action || 'status') + ' [' + (envelope.phase || 'invalid') + ']' + (envelope.code ? ' code=' + envelope.code : ''))
  lines.push(
    'accepted: ' + (envelope.accepted ? 'yes' : 'no') +
    ' | completed: ' + (envelope.completed ? 'yes' : 'no') +
    ' | approved: ' + (envelope.approved ? 'yes' : 'no') +
    ' | state: ' + (envelope.state || 'none') +
    ' | nextAction: ' + (envelope.nextAction || 'none'),
  )
  if (envelope.roundId) lines.push('round: ' + envelope.roundId + (envelope.launchId ? ' (launch ' + envelope.launchId + ')' : ''))
  const capability = isPlainObject(envelope.capability) ? envelope.capability : {}
  if (capability.available === false) {
    lines.push(
      'capability: ' + (capability.code || 'CAPABILITY_UNAVAILABLE') +
      (capability.reason ? ' [' + capability.reason + ']' : '') +
      (Array.isArray(capability.missing) && capability.missing.length ? ' missing=' + capability.missing.join(',') : ''),
    )
    if (capability.detail) lines.push('detail: ' + capability.detail)
  }
  if (Array.isArray(envelope.diagnostics) && envelope.diagnostics.length > 0) {
    lines.push('diagnostics: ' + envelope.diagnostics.map((entry) => entry.code + (entry.path ? '@' + entry.path : '') + ': ' + entry.message).join('; '))
  }
  if (envelope.recovery?.required) lines.push('recovery: ' + envelope.recovery.route + ' - ' + envelope.recovery.detail)
  if (envelope.phase === 'live') lines.push('accepted but NOT completed: no verdict exists yet. Call ulw_review action "wait" (or "status") before reporting any review outcome.')
  if (envelope.phase === 'terminal' && envelope.completed) lines.push('completed: the coordinator approved this round with two bound lane receipts.')
  if (envelope.phase === 'terminal' && !envelope.completed) lines.push('completed: no. This terminal record is history and is not approved; it cannot be reopened.')
  if (envelope.phase === 'rejected') lines.push('completed: no. The request was refused; it never became an approval.')
  if (envelope.phase === 'unavailable') lines.push('completed: no. The enhanced review capability is unavailable, so no requirement or approval exists.')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The command receipt: an accepted round is explicitly not a completed review. */
export function buildReviewReceipt(envelope, target) {
  return (
    'ulw review: accepted round ' + envelope.roundId + ' for ' + target + (envelope.launchId ? ' (launch ' + envelope.launchId + '). ' : '. ') +
    'This receipt is NOT a completed review and no plan verdict exists yet. ' +
    'Call ulw_review action "wait" with roundId "' + envelope.roundId + '" (or action "status") for the result.'
  )
}

/** The existing followup bridge request: continue with wait/status, no new approval. */
export function buildReviewFollowup(envelope, target) {
  return (
    'The user ran \'/ulw-review\' and a Host-owned dual review round is ACCEPTED but NOT completed. ' +
    'This message is a continuation of the user\'s own command - it is not a new user approval, and no verdict exists yet. ' +
    'Continue by calling the ulw_review tool with action "wait" and roundId "' + envelope.roundId + '" (or action "status" for a snapshot). ' +
    'Only the coordinator can approve, and only when both bound lanes return complete OKAY receipts; never report an approval from this message.\n\n' +
    'Target: ' + target + '\nRound: ' + envelope.roundId + '\nState: ' + (envelope.state || 'in_flight') + '\naccepted: yes | completed: no'
  )
}

function commandFailure(envelope, target) {
  const pieces = ['ulw review: ' + envelope.phase]
  if (envelope.code) pieces.push('code=' + envelope.code)
  pieces.push('state=' + (envelope.state || 'none'))
  pieces.push('not accepted (accepted=no, completed=' + (envelope.completed ? 'yes' : 'no') + ')')
  pieces.push('target=' + target)
  if (envelope.capability?.available === false && envelope.capability.missing?.length) {
    pieces.push('missing=' + envelope.capability.missing.join(','))
  }
  if (Array.isArray(envelope.diagnostics) && envelope.diagnostics.length > 0) {
    pieces.push('diagnostics=' + envelope.diagnostics.map((entry) => entry.code).join(','))
  }
  if (envelope.recovery?.required) pieces.push('recovery=' + envelope.recovery.route + ': ' + envelope.recovery.detail)
  return { result: { kind: 'error', text: pieces.join('; ') }, followup: null }
}

const PARAMETERS = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [...REVIEW_ACTIONS],
      description: 'require registers a review requirement, start preflights and starts both lanes, wait polls the accepted round, status reads a snapshot, cancel stops the active round.',
    },
    target: {
      type: 'string',
      description: 'One canonical plan target: .dsh/ulw/plans/<slug>.md (workspace-relative or absolute). Exactly one of target/roundId.',
    },
    roundId: {
      type: 'string',
      description: 'A round identity returned by a previous ulw_review call. Exactly one of target/roundId.',
    },
  },
  required: ['action'],
})

const NULL_SCHEMA = { type: 'null' }
const ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['roundId', 'launchId', 'number', 'state', 'planSha256', 'instructionSha256'],
  properties: {
    roundId: { type: 'string' },
    launchId: { type: 'string' },
    number: { type: 'integer' },
    state: { type: 'string' },
    planSha256: { type: 'string' },
    instructionSha256: { type: 'string' },
  },
}
const LANE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['lane', 'status', 'childId', 'runId', 'verdict', 'complete', 'deliveredBytes', 'totalBytes'],
  properties: {
    lane: { type: 'string' },
    status: { type: 'string' },
    childId: { type: 'string' },
    runId: { type: 'string' },
    verdict: { type: 'string' },
    complete: { type: 'boolean' },
    deliveredBytes: { type: 'integer' },
    totalBytes: { type: 'integer' },
  },
}
const OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: true,
  required: [
    'ok', 'action', 'phase', 'outcome', 'accepted', 'completed', 'terminal', 'approved', 'reused',
    'state', 'code', 'nextAction', 'revision', 'roundId', 'launchId', 'round', 'lanes',
    'requirement', 'budget', 'capability', 'recovery', 'diagnostics', 'detail',
  ],
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    phase: { type: 'string', enum: ['live', 'terminal', 'rejected', 'unavailable', 'invalid', 'missing'] },
    outcome: { type: 'string' },
    accepted: { type: 'boolean' },
    completed: { type: 'boolean' },
    terminal: { type: 'boolean' },
    approved: { type: 'boolean' },
    reused: { type: 'boolean' },
    state: { type: 'string' },
    code: { type: 'string' },
    nextAction: { type: 'string' },
    revision: { type: 'integer' },
    roundId: { type: 'string' },
    launchId: { type: 'string' },
    round: { oneOf: [ROUND_SCHEMA, NULL_SCHEMA] },
    lanes: { type: 'array', items: LANE_SCHEMA },
    requirement: {
      type: 'object',
      additionalProperties: true,
      required: ['exists', 'required', 'state', 'revision', 'rounds', 'target'],
      properties: {
        exists: { type: 'boolean' },
        required: { type: 'boolean' },
        state: { type: 'string' },
        revision: { type: 'integer' },
        rounds: { type: 'integer' },
        target: { type: 'string' },
      },
    },
    budget: {
      type: 'object',
      additionalProperties: true,
      required: ['authorized', 'consumed', 'remaining'],
      properties: {
        authorized: { type: 'integer' },
        consumed: { type: 'integer' },
        remaining: { type: 'integer' },
      },
    },
    capability: {
      type: 'object',
      additionalProperties: true,
      required: ['available', 'code', 'missing', 'reason', 'detail'],
      properties: {
        available: { type: 'boolean' },
        code: { type: 'string' },
        missing: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
        detail: { type: 'string' },
      },
    },
    recovery: {
      type: 'object',
      additionalProperties: true,
      required: ['required', 'route', 'detail'],
      properties: {
        required: { type: 'boolean' },
        route: { type: 'string' },
        detail: { type: 'string' },
      },
    },
    diagnostics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['code', 'path', 'message'],
        properties: {
          code: { type: 'string' },
          path: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    detail: { type: 'string' },
  },
})

export const REVIEW_TOOL_PARAMETERS = PARAMETERS
export const REVIEW_TOOL_OUTPUT_SCHEMA = OUTPUT_SCHEMA

/** The model tool: validate locally, then dispatch the same coordinator as the slash command. */
export function reviewToolDefinition(controller) {
  if (!controller || typeof controller.invoke !== 'function') throw new TypeError('reviewToolDefinition requires the review controller')
  return {
    name: REVIEW_TOOL,
    description:
      'Host-owned dual plan review. Actions: require (register one plan requirement), start (preflight and start both native review lanes), ' +
      'wait (poll the accepted round until both bound lanes settle), status (read a snapshot), cancel (stop the active round). ' +
      'Arguments are selectors only: a canonical .dsh/ulw/plans/<slug>.md target or a round id. This tool never accepts a verdict, approval or note, ' +
      'and its result always states whether the round is merely accepted or actually completed.',
    parameters: REVIEW_TOOL_PARAMETERS,
    output: Object.freeze({
      schema: REVIEW_TOOL_OUTPUT_SCHEMA,
      render: (args, value) => renderReviewEnvelope(value),
    }),
    execute(args, exec) {
      return controller.invoke(args, exec)
    },
  }
}

function roundTracking(assembly) {
  const rounds = []
  return {
    rounds,
    record(coordinator, result) {
      const roundId = textOf(result?.round?.roundId)
      if (!roundId) return
      if (rounds.some((entry) => entry.roundId === roundId && entry.coordinator === coordinator)) return
      rounds.push({ coordinator, roundId })
    },
  }
}

function canonicalWorkspace(cwd) {
  let workspace = cwd
  try { workspace = realpathSync(cwd) } catch { workspace = cwd }
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
    throw Object.assign(new Error('Enhanced review needs a canonical absolute session working directory'), { code: 'INVALID_REQUEST' })
  }
  return workspace
}

function createRunIndex() {
  const started = new Map()
  const waiters = new Map()
  function read(info) {
    if (!isPlainObject(info)) return
    const childId = textOf(info.id)
    const runId = textOf(info.runId)
    if (!childId || !runId) return
    started.set(childId, runId)
    const pending = waiters.get(childId)
    if (pending) {
      waiters.delete(childId)
      for (const resolve of pending) resolve(runId)
    }
  }
  function waitFor(childId) {
    return new Promise((resolve) => {
      const pending = waiters.get(childId) ?? new Set()
      pending.add(resolve)
      waiters.set(childId, pending)
    })
  }
  async function waitForRuns({ childIds, observed } = {}) {
    const collected = {}
    const missing = []
    for (const lane of REVIEW_LANES) {
      const childId = textOf(childIds?.[lane])
      const known = started.get(childId) ?? observed?.get?.(lane)
      if (typeof known === 'string' && known) collected[lane] = known
      else if (childId) missing.push({ lane, childId })
    }
    if (missing.length > 0) {
      const waitersPromise = Promise.all(missing.map((entry) => waitFor(entry.childId)))
      await bounded(waitersPromise, RUN_WAIT_TURNS)
      for (const entry of missing) {
        const runId = started.get(entry.childId)
        if (typeof runId === 'string' && runId) collected[entry.lane] = runId
      }
    }
    return collected
  }
  return { read, waitForRuns, started }
}

/**
 * Assemble the enhanced review modules over the optional Host services.
 * Returns an ownership object (invoke/settle/closeStore/release) or null after
 * attaching a specific capability diagnostic to the controller.
 */
export async function assembleReview({ ctx, config, controller } = {}) {
  if (!ctx || !controller) throw new TypeError('assembleReview requires a context and controller')
  const missing = enhancedMissing(ctx)
  if (missing.length > 0) {
    controller.fail(capabilityStatus(missing))
    return null
  }
  const storage = ctx.get('storage')
  const subagents = ctx.get('subagents')
  const agentPresets = ctx.get('agentPresets')
  const llm = ctx.get('llm')
  const stillStarting = () => controller.state().phase === 'starting'
  let store = null
  let policy = null
  let input = null
  let presetDispose = null
  const unsubs = []
  try {
    store = await openReviewStore({ storage })
    if (!stillStarting()) {
      await bounded(store.close())
      return null
    }
    policy = installReviewPolicy({
      tools: ctx.tools,
      actualPreset: (agent) => {
        try { return agentPresets.composedPreset(agent?.ctx) } catch { return undefined }
      },
    })
    if (!stillStarting()) { await bounded(input?.dispose?.()); await bounded(policy.dispose()); await bounded(store.close()); return null }
    input = installReviewInput({
      tools: ctx.tools,
      policy,
      onResult: (handler) => ctx.on('tools/result', handler),
    })
    presetDispose = await registerReviewPresets(agentPresets)
    if (!stillStarting()) {
      await bounded(presetDispose())
      await bounded(input.dispose())
      await bounded(policy.dispose())
      await bounded(store.close())
      return null
    }
  } catch (error) {
    try { if (presetDispose) await bounded(presetDispose()) } catch { /* the assembly failure owns the report */ }
    try { if (input) await bounded(input.dispose()) } catch { /* ditto */ }
    try { if (policy) await bounded(policy.dispose()) } catch { /* ditto */ }
    try { if (store) await bounded(store.close()) } catch { /* ditto */ }
    controller.fail(capabilityFromError(error))
    return null
  }

  const configSource = () => reviewConfigOf(config)
  const runIndex = createRunIndex()
  unsubs.push(ctx.on('subagent/start', (info) => runIndex.read(info)))
  unsubs.push(ctx.on('subagent/end', () => {}))
  const lifecycle = new AbortController()
  const handles = new Set()
  const disposedHandles = new WeakSet()
  const settleSeams = new Map()
  const tracking = roundTracking()
  const coordinators = new Map()

  const inputSeam = Object.freeze({
    coverageOf: (childId) => input.coverageOf(childId),
    bindReviewInput(binding) {
      const settled = settleSeams.get(binding.childId)
      policy.bindReviewer({
        childId: binding.childId,
        lane: binding.lane,
        preset: REVIEW_LANE_PRESETS[binding.lane],
        ...(settled === undefined ? {} : { settled }),
      })
      return input.bindReviewInput(binding)
    },
  })

  async function startActivations(request) {
    const observed = request?.events
    const events = {
      onStart(listener) {
        return ctx.on('subagent/start', (info) => {
          try { listener(info) } catch { /* observation is never load-bearing */ }
          try { observed?.onStart?.(info) } catch { /* ditto */ }
        })
      },
      onEnd(listener) {
        return ctx.on('subagent/end', (info) => {
          try { listener(info) } catch { /* ditto */ }
          try { observed?.onEnd?.(info) } catch { /* ditto */ }
        })
      },
    }
    const handle = await startReviewActivations({ ...request, events })
    for (const lane of Array.isArray(handle?.lanes) ? handle.lanes : []) {
      if (typeof lane?.childId === 'string' && lane.result !== undefined) settleSeams.set(lane.childId, lane.result)
    }
    handles.add(handle)
    return handle
  }

  function coordinatorFor(agent) {
    const sessionId = textOf(agent?.session?.id)
    const cwd = agent?.session?.header?.cwd ?? (agent?.session ? ctx.workingDirectory.get(agent.session) : undefined)
    const workspace = canonicalWorkspace(typeof cwd === 'string' ? cwd : '')
    const key = sessionId + '\u0000' + workspace
    let coordinator = coordinators.get(key)
    if (!coordinator) {
      coordinator = createReviewCoordinator({
        workspace,
        config: configSource,
        store,
        input: inputSeam,
        subagents,
        llm,
        parent: agent,
        signal: lifecycle.signal,
        waitForRuns: (request) => runIndex.waitForRuns(request),
        startActivations,
      })
      coordinators.set(key, coordinator)
    }
    return coordinator
  }

  async function invoke(action, request, exec) {
    const coordinator = coordinatorFor(exec?.agent)
    const result = await coordinator[action](request)
    tracking.record(coordinator, result)
    return result
  }

  async function settle() {
    const diagnostics = []
    try { lifecycle.abort() } catch { /* pre-acceptance cancellation only */ }
    for (const entry of [...tracking.rounds].reverse()) {
      const outcome = await bounded(entry.coordinator.cancel({ roundId: entry.roundId }))
      if (outcome.timedOut) {
        diagnostics.push(diagnostic('CANCEL_TIMEOUT', '$.roundId', 'Cancelling round ' + entry.roundId + ' did not settle before dispose'))
      } else if (outcome.error) {
        diagnostics.push(...errorDiagnostics(outcome.error))
      } else if (outcome.value && outcome.value.ok === false) {
        diagnostics.push(diagnostic(
          textOf(outcome.value.code) || 'CANCEL_REJECTED',
          '$.roundId',
          'Round ' + entry.roundId + ' could not be persisted as terminal during dispose; a human/new record is required',
        ))
      }
    }
    for (const handle of handles) {
      if (!handle || disposedHandles.has(handle)) continue
      disposedHandles.add(handle)
      try { handle.releaseObservers?.() } catch (error) {
        diagnostics.push(diagnostic(errorCode(error, 'DISPOSE_FAILED'), '$', 'Lifecycle observer release failed: ' + errorMessage(error)))
      }
      const outcome = await bounded(handle.dispose?.())
      if (outcome.timedOut) diagnostics.push(diagnostic('DISPOSE_TIMEOUT', '$', 'Review activation disposal did not settle'))
      else if (outcome.error) diagnostics.push(...errorDiagnostics(outcome.error))
    }
    let bindings = {}
    try { bindings = policy.state() ?? {} } catch { bindings = {} }
    for (const childId of Object.keys(bindings)) {
      try { policy.settleReviewer(childId) } catch { /* a late settle is already terminal */ }
    }
    return { diagnostics }
  }

  async function closeStore() {
    const outcome = await bounded(store.close())
    if (outcome.timedOut) return { diagnostics: [diagnostic('STORE_CLOSE_TIMEOUT', '$', 'The review store unit did not close before dispose finished')] }
    if (outcome.error) return { diagnostics: errorDiagnostics(outcome.error) }
    return { diagnostics: [] }
  }

  async function release() {
    const diagnostics = []
    const steps = [
      ['input', () => input?.dispose?.()],
      ['guard', () => policy?.dispose?.()],
      ['presets', () => (presetDispose ? presetDispose() : undefined)],
    ]
    for (const [name, step] of steps) {
      const outcome = await bounded(step())
      if (outcome.timedOut) diagnostics.push(diagnostic('RELEASE_TIMEOUT', '$', 'Releasing the ' + name + ' registration did not settle'))
      else if (outcome.error) diagnostics.push(diagnostic(errorCode(outcome.error, 'RELEASE_FAILED'), '$', 'Releasing the ' + name + ' registration failed: ' + errorMessage(outcome.error)))
    }
    for (const unsub of unsubs.reverse()) {
      try { unsub() } catch { /* listener ownership is fiber-scoped anyway */ }
    }
    return { diagnostics }
  }

  return Object.freeze({ invoke, settle, closeStore, release })
}

/** Build the review controller: assembly state plus the two entrypoints. */
export function createReviewController(options = {}) {
  const config = options.config
  let phase = 'starting'
  let capability = pendingCapability()
  let assembly = null
  let admission = true
  let disposal = null
  let disposeResult = null

  const state = () => deepFreeze({ phase, available: capability.available === true, ...capability })

  function admissionIssue() {
    if (phase === 'ready') return null
    if (phase === 'failed') return capability
    if (phase === 'stopping' || phase === 'disposed') return shuttingDownCapability()
    return pendingCapability()
  }

  function attach(value) {
    if (!admission) return false
    assembly = value
    phase = 'ready'
    capability = readyCapability()
    return true
  }

  function fail(status) {
    capability = { ...pendingCapability(), ...(isPlainObject(status) ? status : {}) }
    phase = 'failed'
  }

  function stopAdmission() {
    admission = false
    if (phase === 'ready' || phase === 'starting') phase = 'stopping'
  }

  function finish() {
    phase = 'disposed'
    admission = false
  }

  async function runParsed(parsed, exec) {
    const action = parsed.action
    try {
      const raced = await raceSignal(assembly.invoke(action, parsed, exec), exec?.signal)
      if (raced.aborted) {
        return buildReviewEnvelope({
          ok: false, action, outcome: 'cancelled', code: 'CANCELLED',
          diagnostics: [diagnostic('CANCELLED', '$', 'The caller cancelled while the review operation was in progress; the durable round is unchanged and must be inspected with action=status')],
        }, { action, capability: readyCapability() })
      }
      return buildReviewEnvelope(raced.value, { action, capability: readyCapability() })
    } catch (error) {
      return buildReviewEnvelope({
        ok: false, action, outcome: 'error', code: errorCode(error), diagnostics: errorDiagnostics(error),
      }, { action, capability: readyCapability() })
    }
  }

  async function invoke(rawArgs, exec) {
    const action = isPlainObject(rawArgs) ? textOf(rawArgs.action) : ''
    const issue = admissionIssue()
    if (issue) {
      return buildReviewEnvelope({
        ok: false, action, outcome: issue.available ? 'error' : 'unavailable', code: issue.code,
        diagnostics: [diagnostic(issue.code, '$', issue.detail)],
      }, { action, capability: issue })
    }
    let parsed
    try {
      parsed = parseReviewRequest(rawArgs)
    } catch (error) {
      return buildReviewEnvelope({
        ok: false, action, outcome: 'invalid_request', code: errorCode(error), diagnostics: errorDiagnostics(error),
      }, { action, capability: readyCapability() })
    }
    if (!exec || !exec.agent || typeof exec.agent !== 'object') {
      return buildReviewEnvelope({
        ok: false, action: parsed.action, outcome: 'invalid_request', code: 'INVALID_REQUEST',
        diagnostics: [diagnostic('INVALID_REQUEST', '$', 'ulw_review requires the calling agent to resolve its workspace and session')],
      }, { action: parsed.action, capability: readyCapability() })
    }
    return runParsed(parsed, exec)
  }

  async function command(request) {
    const target = request?.target
    const agent = request?.agent
    const signal = request?.signal
    if (!target || target.ok !== true || typeof target.absolute !== 'string') {
      const detail = nonEmptyText(target?.error) || 'Resolve exactly one .dsh/ulw/plans/<slug>.md plan path before reviewing it'
      return { result: { kind: 'error', text: 'ulw review: INVALID_REQUEST; ' + detail }, followup: null }
    }
    const required = await invoke({ action: 'require', target: target.absolute }, { agent, signal })
    if (required.phase === 'terminal' && required.completed) {
      return {
        result: { kind: 'success', text: 'ulw review: round ' + required.roundId + ' is already completed with two bound receipts (state approved). No new round was started.' },
        followup: null,
      }
    }
    if (required.phase !== 'live') return commandFailure(required, target.absolute)
    const started = await invoke({ action: 'start', target: target.absolute }, { agent, signal })
    if (started.phase === 'terminal' && started.completed) {
      return {
        result: { kind: 'success', text: 'ulw review: round ' + started.roundId + ' is already completed with two bound receipts (state approved). No new round was started.' },
        followup: null,
      }
    }
    if (started.phase !== 'live' || started.accepted !== true || !started.roundId) return commandFailure(started, target.absolute)
    return {
      result: { kind: 'success', text: buildReviewReceipt(started, target.absolute) },
      followup: buildReviewFollowup(started, target.absolute),
    }
  }

  function dispose(value) {
    if (disposal) return disposal
    disposal = (async () => {
      const diagnostics = []
      if (value) {
        for (const step of ['settle', 'closeStore', 'release']) {
          let outcome
          try { outcome = await bounded(value[step]?.()) } catch (error) {
            diagnostics.push(...errorDiagnostics(error))
            continue
          }
          if (outcome.timedOut) {
            diagnostics.push(diagnostic('DISPOSE_STEP_TIMEOUT', '$', 'Dispose step "' + step + '" did not settle; later owners still run in order'))
          } else if (outcome.error) {
            diagnostics.push(diagnostic(errorCode(outcome.error, 'DISPOSE_FAILED'), '$', 'Dispose step "' + step + '" failed: ' + errorMessage(outcome.error)))
          } else if (Array.isArray(outcome.value?.diagnostics)) {
            diagnostics.push(...normalizeDiagnostics(outcome.value.diagnostics))
          }
        }
      }
      disposeResult = { diagnostics }
      return disposeResult
    })()
    return disposal
  }

  const router = Object.freeze({ command: (request) => command(request) })

  return Object.freeze({
    state,
    attach,
    fail,
    stopAdmission,
    finish,
    invoke,
    command,
    dispose,
    router,
    diagnostics: () => (disposeResult ? deepFreeze(disposeResult) : null),
  })
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.length > 0 ? value : ''
}

/**
 * Create the review contribution for one Host context.
 * Registers the model tool immediately, starts the optional assembly through
 * the returned effect body, and returns the slash-command router.
 */
export function createReviewEntry(ctx, options = {}) {
  const controller = createReviewController({ config: options.config })
  let removeTool = null
  let registrationError = null
  if (ctx?.tools && typeof ctx.tools.register === 'function') {
    try {
      removeTool = ctx.tools.register(reviewToolDefinition(controller))
    } catch (error) {
      registrationError = error
      controller.fail(capabilityFromError(error, 'REVIEW_TOOL_REGISTRATION_FAILED'))
    }
  } else {
    registrationError = Object.assign(new Error('ulw_review needs the Host tools registry (ctx.tools.register)'), { code: 'CAPABILITY_UNAVAILABLE' })
    controller.fail({
      available: false, code: 'CAPABILITY_UNAVAILABLE', missing: [], reason: 'MISSING_TOOLS',
      detail: 'ulw_review needs the Host tools registry (ctx.tools.register)',
    })
  }
  const assemble = typeof options.assemble === 'function' ? options.assemble : assembleReview
  let ready = null
  let started = false
  let disposal = null
  const entry = {
    controller,
    router: controller.router,
    get ready() { return ready ?? Promise.resolve(null) },
    start() {
      if (!started) {
        started = true
        ready = Promise.resolve()
          .then(() => (registrationError ? null : assemble({ ctx, config: options.config, controller })))
          .then((value) => {
            if (value) controller.attach(value)
            return value ?? null
          })
          .catch((error) => {
            controller.fail(capabilityFromError(error))
            return null
          })
        ready.catch(() => {})
      }
      return () => disposeEntry()
    },
    dispose: () => disposeEntry(),
  }
  async function disposeEntry() {
    if (disposal) return disposal
    disposal = (async () => {
      controller.stopAdmission()
      let value = null
      if (ready) {
        const settled = await bounded(ready)
        if (!settled.timedOut) value = settled.value ?? null
      }
      const result = await controller.dispose(value)
      if (typeof removeTool === 'function') {
        try { removeTool() } catch { /* its exact effect disposer already ran with the fiber */ }
        removeTool = null
      }
      controller.finish()
      return result
    })()
    return disposal
  }
  return Object.freeze(entry)
}
