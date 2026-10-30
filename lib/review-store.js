/** Host-owned durable review state (Scope interface 7).
 *
 * The Host KV unit is the authority for plan-review state; workspace Markdown,
 * JSON drafts and evidence exports are never read here. One plan is one record:
 * the complete, protocol/state-validated value stored under the SHA-256 of its
 * canonical workspace + workspace-relative target. Every load and write runs
 * the pure validators. Writes run on one promise chain, persist before the
 * in-memory record and the handoff-facing approval change, and a failed write
 * leaves both untouched. Startup converts an interrupted round to a terminal
 * inconclusive record when that can be done without inventing runtime identity;
 * otherwise the key is refused fail-closed instead of being dropped or forged.
 * Only this unit is closed; the Host backend stays owned by its plugin.
 */
import { createHash } from 'node:crypto'
import {
  REVIEW_LANES,
  ReviewContractError,
  assertPlainJson,
  parseHandoffRequest,
} from './review-protocol.js'
import {
  createReviewRecord,
  evaluateApproval,
  reduceReview,
  validateReviewRecord,
} from './review-state.js'

export const REVIEW_STORE_UNIT_NAME = 'ulw_plan_review'
export const REVIEW_STORE_TABLE = 'plans'
export const REVIEW_STORE_UNIT = Object.freeze({
  name: REVIEW_STORE_UNIT_NAME,
  version: 1,
  tables: Object.freeze([REVIEW_STORE_TABLE]),
  hasGlobal: false,
  layout: 'single',
})

const IDENTITY_KEYS = Object.freeze(['workspace', 'target'])
const KEY_PATTERN = /^[a-f0-9]{64}$/
const EMPTY_DIAGNOSTICS = Object.freeze([])
const EMPTY_APPROVAL = Object.freeze({
  approved: false,
  required: false,
  state: null,
  roundId: null,
  revision: null,
  receipts: null,
  source: null,
  policy: null,
})

export class ReviewStoreError extends Error {
  constructor(code, message, { diagnostics = [], cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ReviewStoreError'
    this.code = code
    this.diagnostics = freezeDiagnostics(diagnostics)
  }
}

const fail = (code, message, options) => { throw new ReviewStoreError(code, message, options) }
const diagnostic = (code, path, message) => ({ code, path, message })
const clonePlain = value => JSON.parse(JSON.stringify(value))
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
const frozenClone = value => deepFreeze(clonePlain(value))
const freezeDiagnostics = list => Object.freeze(list.map(entry => Object.freeze({
  code: entry?.code ?? 'INVALID_REQUEST',
  path: entry?.path ?? '$',
  message: String(entry?.message ?? ''),
})))
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/** Canonical identity: absolute canonical workspace + workspace-relative plan
 * target. An absolute target is accepted only when it lives under the same
 * workspace; the stored key never depends on how the target was written.
 */
export function canonicalReviewIdentity(raw) {
  let workspace, relative
  try {
    assertPlainJson(raw)
    if (!plainObject(raw)) fail('INVALID_IDENTITY', 'Expected a plain identity object')
    const keys = Object.keys(raw)
    if (keys.length !== IDENTITY_KEYS.length || keys.some(key => !IDENTITY_KEYS.includes(key))) {
      fail('INVALID_IDENTITY', 'Expected exactly one workspace and one target')
    }
    if (typeof raw.workspace !== 'string' || typeof raw.target !== 'string') {
      fail('INVALID_IDENTITY', 'Workspace and target must be strings')
    }
    workspace = raw.workspace
    relative = raw.target
    if (relative.startsWith('/')) {
      const prefix = workspace === '/' ? '/' : workspace + '/'
      if (!relative.startsWith(prefix)) fail('INVALID_IDENTITY', 'Absolute target is outside the workspace')
      relative = relative.slice(prefix.length)
    }
    const parsed = parseHandoffRequest({ action: 'bind-worktree', target: relative, worktreePath: workspace })
    if (parsed.target !== relative || parsed.worktreePath !== workspace) {
      fail('INVALID_IDENTITY', 'Identity is not canonical')
    }
  } catch (error) {
    if (error instanceof ReviewStoreError) throw error
    const detail = error instanceof ReviewContractError
      ? { code: error.code, path: error.path ?? '$', message: error.message }
      : { code: 'INVALID_IDENTITY', path: '$', message: 'Invalid review identity' }
    fail('INVALID_IDENTITY', 'Invalid review identity: ' + detail.message, { diagnostics: [detail] })
  }
  const key = createHash('sha256').update(JSON.stringify([workspace, relative]), 'utf8').digest('hex')
  return Object.freeze({ workspace, target: relative, key })
}

/** SHA-256 key of one plan: canonical workspace plus relative target only. */
export function reviewStoreKey(identity) {
  return canonicalReviewIdentity(identity).key
}

/** Strict stored-record rule on top of validateReviewRecord: identity must match
 * its key, and an approved record must approve its LAST round. Approval of an
 * earlier round is stale history, never a lease.
 */
export function validateStoredReviewRecord(raw, expectedKey) {
  const checked = validateReviewRecord(raw)
  if (!checked.ok) {
    return { ok: false, code: 'RECORD_INVALID', diagnostics: freezeDiagnostics(checked.diagnostics) }
  }
  let identity
  try {
    identity = canonicalReviewIdentity({ workspace: raw.workspace, target: raw.target })
  } catch (error) {
    const details = error instanceof ReviewStoreError && error.diagnostics.length
      ? error.diagnostics
      : [diagnostic('RECORD_INVALID', '$.target', 'Record identity is not canonical')]
    return { ok: false, code: 'RECORD_INVALID', diagnostics: freezeDiagnostics(details) }
  }
  if (expectedKey !== undefined && identity.key !== expectedKey) {
    return {
      ok: false,
      code: 'RECORD_KEY_MISMATCH',
      diagnostics: freezeDiagnostics([diagnostic('RECORD_KEY_MISMATCH', '$.target', 'Record identity does not match its storage key')]),
    }
  }
  const approval = evaluateApproval(raw)
  const last = raw.rounds.at(-1) ?? null
  if (raw.state === 'approved') {
    if (!last || last.roundId !== raw.approvedRoundId) {
      return {
        ok: false,
        code: 'APPROVAL_NOT_LAST_ROUND',
        diagnostics: freezeDiagnostics([diagnostic('APPROVAL_NOT_LAST_ROUND', '$.approvedRoundId', 'An approved record must approve its final round')]),
      }
    }
    if (!approval.approved) {
      return {
        ok: false,
        code: 'APPROVAL_INVALID',
        diagnostics: freezeDiagnostics([diagnostic('APPROVAL_INVALID', '$.state', 'Approved record does not satisfy the approval predicate: ' + approval.reasons.join(','))]),
      }
    }
  } else if (approval.approved) {
    return {
      ok: false,
      code: 'APPROVAL_CONTRADICTION',
      diagnostics: freezeDiagnostics([diagnostic('APPROVAL_CONTRADICTION', '$.state', 'A non-approved state cannot satisfy the approval predicate')]),
    }
  }
  return { ok: true, code: null, diagnostics: EMPTY_DIAGNOSTICS }
}
function approvalSnapshot(record) {
  if (!record) return EMPTY_APPROVAL
  let approval
  try {
    approval = evaluateApproval(record)
  } catch {
    approval = { approved: false, receipts: null, roundId: null, reasons: ['INVALID_RECORD'] }
  }
  const approved = approval.approved === true && record.state === 'approved'
  return frozenClone({
    approved,
    required: record.required === true,
    state: record.state,
    roundId: approved ? approval.roundId : null,
    revision: record.revision,
    receipts: approved ? approval.receipts : null,
    source: record.source,
    policy: record.policy,
  })
}

/** Refuse an interrupted record that cannot be made terminal without inventing
 * a run identity: a launching round never bound one, and a terminal lane needs
 * a real run id. Dropping the round would also falsify budget accounting.
 */
function recoverInterruptedRecord(record) {
  if (record.activeRoundId === null) return { ok: true, needed: false, record }
  const index = record.rounds.findIndex(round => round.roundId === record.activeRoundId)
  const refuse = (code, path, message, detailCode = code) => ({
    ok: false,
    code: 'RECOVERY_REFUSED',
    diagnostics: freezeDiagnostics([diagnostic(detailCode, path, message)]),
  })
  if (index < 0) return refuse('RECOVERY_INVALID', '$.activeRoundId', 'The active round is missing')
  if (index !== record.rounds.length - 1) return refuse('RECOVERY_INVALID', '$.activeRoundId', 'Only the final round may be active')
  const round = record.rounds[index]
  const lanes = {}
  for (const laneName of REVIEW_LANES) {
    const lane = round.lanes?.[laneName]
    if (!lane) return refuse('RECOVERY_INVALID', '$.rounds.' + index + '.lanes.' + laneName, 'The active round is missing a lane')
    if (lane.status !== 'in_flight') {
      lanes[laneName] = lane
      continue
    }
    if (lane.runId === null) {
      return refuse(
        'INTERRUPTED_UNBOUND_LANE',
        '$.rounds.' + index + '.lanes.' + laneName + '.runId',
        'An interrupted lane without a bound run cannot become terminal without forging runtime identity',
      )
    }
    lanes[laneName] = { ...lane, status: 'failed', result: null, receipt: null, reason: 'interrupted' }
  }
  const recovered = {
    ...record,
    state: 'inconclusive',
    activeRoundId: null,
    approvedRoundId: null,
    revision: record.revision + 1,
    rounds: record.rounds.map((entry, position) => position === index
      ? { ...entry, state: 'inconclusive', lanes }
      : entry),
  }
  const checked = validateStoredReviewRecord(recovered)
  if (!checked.ok) {
    return refuse('RECOVERY_INVALID', '$.state', 'The recovered record is not valid: ' + (checked.diagnostics[0]?.message ?? checked.code))
  }
  return { ok: true, needed: true, record: frozenClone(recovered) }
}

const makeResult = fields => Object.freeze({
  ok: false,
  outcome: 'rejected',
  code: null,
  key: null,
  record: null,
  approved: false,
  required: false,
  changed: false,
  persisted: false,
  charged: 0,
  diagnostics: EMPTY_DIAGNOSTICS,
  ...fields,
})
const closedDiagnostics = () => freezeDiagnostics([diagnostic('STORE_CLOSED', '$', 'The review KV unit is closed')])
const storeClosedResult = key => makeResult({
  outcome: 'store_closed',
  code: 'STORE_CLOSED',
  key,
  diagnostics: closedDiagnostics(),
})
class ReviewStore {
  #unit
  #records = new Map()
  #approvals = new Map()
  #quarantine = new Map()
  #recovered = []
  #chain = Promise.resolve()
  #closing = false
  #closed = false
  #closePromise = null

  constructor(unit) {
    this.#unit = unit
    this.descriptor = REVIEW_STORE_UNIT
  }

  static async open(unit) {
    const store = new ReviewStore(unit)
    await store.#load()
    return store
  }

  /** Exact read: validators run again and a poisoned memory entry fails closed. */
  status(identity) {
    const resolved = this.#resolve(identity)
    if (!resolved.ok) return Object.freeze({ ok: false, code: 'INVALID_IDENTITY', key: null, exists: false, record: null, approval: EMPTY_APPROVAL, diagnostics: resolved.diagnostics })
    const key = resolved.identity.key
    if (this.#closed || this.#closing) return Object.freeze({ ok: false, code: 'STORE_CLOSED', key, exists: false, record: null, approval: EMPTY_APPROVAL, diagnostics: closedDiagnostics() })
    const quarantine = this.#quarantine.get(key)
    if (quarantine) return Object.freeze({ ok: false, code: quarantine.code, key, exists: true, record: null, approval: EMPTY_APPROVAL, diagnostics: quarantine.diagnostics })
    const record = this.#records.get(key)
    if (!record) return Object.freeze({ ok: true, code: null, key, exists: false, record: null, approval: EMPTY_APPROVAL, diagnostics: EMPTY_DIAGNOSTICS })
    const checked = validateStoredReviewRecord(record, key)
    if (!checked.ok) {
      this.#quarantine.set(key, { code: checked.code, diagnostics: checked.diagnostics })
      this.#records.delete(key)
      this.#approvals.delete(key)
      return Object.freeze({ ok: false, code: checked.code, key, exists: true, record: null, approval: EMPTY_APPROVAL, diagnostics: checked.diagnostics })
    }
    const approval = this.#approvalFor(key, record)
    if (approval === null) {
      const failure = this.#poison(key, 'APPROVAL_CACHE_MISMATCH')
      return Object.freeze({ ok: false, code: failure.code, key, exists: true, record: null, approval: EMPTY_APPROVAL, diagnostics: failure.diagnostics })
    }
    return Object.freeze({ ok: true, code: null, key, exists: true, record, approval, diagnostics: EMPTY_DIAGNOSTICS })
  }

  /** Handoff-facing approval. Consumers grant a lease only for ok && approved. */
  approval(identity) {
    const resolved = this.#resolve(identity)
    if (!resolved.ok) return Object.freeze({ ...EMPTY_APPROVAL, ok: false, code: 'INVALID_IDENTITY', key: null, exists: false, diagnostics: resolved.diagnostics })
    const key = resolved.identity.key
    if (this.#closed || this.#closing) return Object.freeze({ ...EMPTY_APPROVAL, ok: false, code: 'STORE_CLOSED', key, exists: false, diagnostics: closedDiagnostics() })
    const quarantine = this.#quarantine.get(key)
    if (quarantine) return Object.freeze({ ...EMPTY_APPROVAL, ok: false, code: quarantine.code, key, exists: true, diagnostics: quarantine.diagnostics })
    const record = this.#records.get(key)
    if (!record) return Object.freeze({ ...EMPTY_APPROVAL, ok: true, code: null, key, exists: false, diagnostics: EMPTY_DIAGNOSTICS })
    const checked = validateStoredReviewRecord(record, key)
    if (!checked.ok) {
      this.#quarantine.set(key, { code: checked.code, diagnostics: checked.diagnostics })
      this.#records.delete(key)
      this.#approvals.delete(key)
      return Object.freeze({ ...EMPTY_APPROVAL, ok: false, code: checked.code, key, exists: true, diagnostics: checked.diagnostics })
    }
    const snapshot = this.#approvalFor(key, record)
    if (snapshot === null) {
      const failure = this.#poison(key, 'APPROVAL_CACHE_MISMATCH')
      return Object.freeze({ ...EMPTY_APPROVAL, ok: false, code: failure.code, key, exists: true, diagnostics: failure.diagnostics })
    }
    return Object.freeze({ ...snapshot, ok: true, code: null, key, exists: true, diagnostics: EMPTY_DIAGNOSTICS })
  }

  /** Create once. An existing record (including a refused one) is never
   * overwritten: creation cannot resurrect approval or paper over corruption.
   */
  create(identity, input) {
    const resolved = this.#resolve(identity)
    if (!resolved.ok) return Promise.resolve(makeResult({ outcome: 'invalid_identity', code: 'INVALID_IDENTITY', diagnostics: resolved.diagnostics }))
    if (this.#closed || this.#closing) return Promise.resolve(storeClosedResult(resolved.identity.key))
    return this.#enqueue(() => this.#createLocked(resolved.identity, input))
  }

  /** Apply one reducer event through the durable chain. approved describes THIS
   * transition only; a rejected event always reports approved:false even when
   * the unchanged record was already approved.
   */
  apply(identity, event) {
    const resolved = this.#resolve(identity)
    if (!resolved.ok) return Promise.resolve(makeResult({ outcome: 'invalid_identity', code: 'INVALID_IDENTITY', diagnostics: resolved.diagnostics }))
    if (this.#closed || this.#closing) return Promise.resolve(storeClosedResult(resolved.identity.key))
    return this.#enqueue(() => this.#applyLocked(resolved.identity, event))
  }

  health() {
    return deepFreeze({
      ok: true,
      closed: this.#closed || this.#closing,
      unit: {
        name: this.descriptor.name,
        version: this.descriptor.version,
        tables: [...this.descriptor.tables],
        hasGlobal: this.descriptor.hasGlobal,
        layout: this.descriptor.layout,
      },
      records: this.#records.size,
      recovered: this.#recovered.map(entry => ({ ...entry })),
      quarantined: [...this.#quarantine.entries()].map(([key, entry]) => ({
        key,
        code: entry.code,
        diagnostics: entry.diagnostics.map(item => ({ ...item })),
      })),
    })
  }

  /** Drain this unit's chain, close this unit only, stay idempotent. */
  close() {
    if (this.#closePromise) return this.#closePromise
    this.#closing = true
    this.#closePromise = (async () => {
      try { await this.#chain } catch { /* operations already failed closed */ }
      let failure = null
      try { await this.#unit.close() } catch (error) { failure = error }
      this.#closed = true
      this.#closing = false
      if (failure) {
        fail('CLOSE_FAILED', 'The review KV unit could not be closed', {
          cause: failure,
          diagnostics: [diagnostic(failure?.code ?? 'CLOSE_FAILED', '$', 'KV close failed: ' + (failure?.message ?? 'unknown error'))],
        })
      }
    })()
    return this.#closePromise
  }

  #enqueue(work) {
    if (this.#closed || this.#closing) return Promise.resolve(storeClosedResult(null))
    const run = this.#chain.then(() => work())
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  #resolve(identity) {
    try {
      return { ok: true, identity: canonicalReviewIdentity(identity) }
    } catch (error) {
      const details = error instanceof ReviewStoreError && error.diagnostics.length
        ? error.diagnostics
        : [diagnostic('INVALID_IDENTITY', '$', 'Invalid review identity')]
      return { ok: false, diagnostics: freezeDiagnostics(details) }
    }
  }

  #approvalFor(key, record) {
    const snapshot = approvalSnapshot(record)
    const cached = this.#approvals.get(key)
    if (!cached) {
      this.#approvals.set(key, snapshot)
      return snapshot
    }
    if (JSON.stringify(cached) !== JSON.stringify(snapshot)) return null
    return cached
  }

  #poison(key, code) {
    const diagnostics = freezeDiagnostics([diagnostic(code, '$', 'Durable record and cached approval disagree')])
    this.#quarantine.set(key, { code, diagnostics })
    this.#records.delete(key)
    this.#approvals.delete(key)
    return { ok: false, code, diagnostics }
  }

  async #createLocked(identity, input) {
    const key = identity.key
    if (this.#closed) return storeClosedResult(key)
    const quarantine = this.#quarantine.get(key)
    if (quarantine) return makeResult({ outcome: 'record_invalid', code: quarantine.code, key, diagnostics: quarantine.diagnostics })
    try {
      assertPlainJson(input)
      if (!plainObject(input)) fail('INVALID_REQUEST', 'Expected a plain create input')
      if (Object.hasOwn(input, 'target') && input.target !== identity.target) fail('INVALID_IDENTITY', 'Create target differs from the store identity')
      if (Object.hasOwn(input, 'workspace') && input.workspace !== identity.workspace) fail('INVALID_IDENTITY', 'Create workspace differs from the store identity')
    } catch (error) {
      const diagnostics = this.#errorDiagnostics(error, 'INVALID_REQUEST')
      return makeResult({ outcome: 'invalid_request', code: diagnostics[0]?.code ?? 'INVALID_REQUEST', key, diagnostics })
    }
    const existing = this.#records.get(key)
    if (existing) {
      const approval = this.#approvalFor(key, existing) ?? EMPTY_APPROVAL
      return makeResult({
        ok: true,
        outcome: 'existing',
        key,
        record: existing,
        approved: approval.approved,
        required: existing.required === true,
        diagnostics: EMPTY_DIAGNOSTICS,
      })
    }
    let candidate
    try {
      candidate = createReviewRecord({ ...input, target: identity.target, workspace: identity.workspace })
    } catch (error) {
      const diagnostics = this.#errorDiagnostics(error, 'INVALID_REQUEST')
      return makeResult({ outcome: 'invalid_request', code: diagnostics[0]?.code ?? 'INVALID_REQUEST', key, diagnostics })
    }
    const checked = validateStoredReviewRecord(candidate, key)
    if (!checked.ok) return makeResult({ outcome: 'invalid_transition', code: checked.code, key, diagnostics: checked.diagnostics })
    const persisted = await this.#persistLocked(key, candidate)
    if (!persisted.ok) return makeResult({ outcome: 'persist_failed', code: 'PERSIST_FAILED', key, diagnostics: persisted.diagnostics })
    return makeResult({
      ok: true,
      outcome: 'created',
      key,
      record: persisted.record,
      required: persisted.record.required === true,
      changed: true,
      persisted: true,
      diagnostics: EMPTY_DIAGNOSTICS,
    })
  }

  async #applyLocked(identity, event) {
    const key = identity.key
    if (this.#closed) return storeClosedResult(key)
    const quarantine = this.#quarantine.get(key)
    if (quarantine) return makeResult({ outcome: 'record_invalid', code: quarantine.code, key, diagnostics: quarantine.diagnostics })
    const current = this.#records.get(key)
    if (!current) {
      return makeResult({
        outcome: 'missing_record',
        code: 'NO_RECORD',
        key,
        diagnostics: freezeDiagnostics([diagnostic('NO_RECORD', '$', 'No durable review record exists for this identity')]),
      })
    }
    const result = reduceReview(current, event)
    const diagnostics = freezeDiagnostics(result.diagnostics ?? [])
    if (!result.ok) {
      return makeResult({
        outcome: result.outcome,
        code: diagnostics[0]?.code ?? 'INVALID_TRANSITION',
        key,
        record: current,
        approved: false,
        required: current.required === true,
        diagnostics,
      })
    }
    const prior = this.#approvalFor(key, current) ?? EMPTY_APPROVAL
    if (result.record.revision === current.revision) {
      return makeResult({
        ok: true,
        outcome: result.outcome,
        key,
        record: current,
        approved: prior.approved,
        required: current.required === true,
        diagnostics,
      })
    }
    const checked = validateStoredReviewRecord(result.record, key)
    if (!checked.ok) {
      return makeResult({
        outcome: 'invalid_transition',
        code: checked.code,
        key,
        record: current,
        required: current.required === true,
        diagnostics: checked.diagnostics,
      })
    }
    const persisted = await this.#persistLocked(key, result.record)
    if (!persisted.ok) {
      return makeResult({
        outcome: 'persist_failed',
        code: 'PERSIST_FAILED',
        key,
        record: current,
        required: current.required === true,
        diagnostics: persisted.diagnostics,
      })
    }
    return makeResult({
      ok: true,
      outcome: result.outcome,
      key,
      record: persisted.record,
      approved: result.approved === true && persisted.record.state === 'approved',
      required: persisted.record.required === true,
      changed: true,
      persisted: true,
      charged: Number.isSafeInteger(result.charged) ? result.charged : 0,
      diagnostics,
    })
  }

  async #persistLocked(key, record) {
    const stored = frozenClone(record)
    const checked = validateStoredReviewRecord(stored, key)
    if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics }
    try {
      await this.#unit.putRecord(REVIEW_STORE_TABLE, key, clonePlain(stored))
    } catch (error) {
      return {
        ok: false,
        diagnostics: freezeDiagnostics([diagnostic('PERSIST_FAILED', '$', 'Durable write failed: ' + (error?.message ?? 'unknown error'))]),
      }
    }
    // Durable first: memory and the approval cache change only after the write resolves.
    this.#records.set(key, stored)
    this.#approvals.set(key, approvalSnapshot(stored))
    return { ok: true, record: stored }
  }

  async #load() {
    let snapshot
    try {
      snapshot = await this.#unit.loadAll()
    } catch (error) {
      await this.#safeUnitClose()
      fail('STORE_LOAD_FAILED', 'The review KV unit could not be read', {
        cause: error,
        diagnostics: [diagnostic(error?.code ?? 'STORE_LOAD_FAILED', '$', 'Durable read failed: ' + (error?.message ?? 'unknown error'))],
      })
    }
    if (!plainObject(snapshot) || !Object.hasOwn(snapshot, 'global') || snapshot.global !== null || !plainObject(snapshot.tables)) {
      await this.#safeUnitClose()
      fail('STORE_CORRUPT', 'The review KV unit has an unrecognized shape', {
        diagnostics: [diagnostic('STORE_CORRUPT', '$', 'Expected a single-table unit without a global slot')],
      })
    }
    const tableNames = Object.keys(snapshot.tables)
    if (tableNames.length !== 1 || tableNames[0] !== REVIEW_STORE_TABLE) {
      await this.#safeUnitClose()
      fail('STORE_CORRUPT', 'The review KV unit holds an undeclared table', {
        diagnostics: [diagnostic('STORE_CORRUPT', '$', 'Expected exactly the ' + REVIEW_STORE_TABLE + ' table')],
      })
    }
    const table = snapshot.tables[REVIEW_STORE_TABLE]
    if (!plainObject(table)) {
      await this.#safeUnitClose()
      fail('STORE_CORRUPT', 'The review table is not a record map', {
        diagnostics: [diagnostic('STORE_CORRUPT', '$', 'Expected an object of records')],
      })
    }
    for (const key of Object.keys(table)) {
      if (!KEY_PATTERN.test(key)) {
        this.#quarantine.set(key, {
          code: 'RECORD_INVALID',
          diagnostics: freezeDiagnostics([diagnostic('RECORD_INVALID', '$', 'The storage key is not a review identity digest')]),
        })
        continue
      }
      const checked = validateStoredReviewRecord(table[key], key)
      if (!checked.ok) {
        this.#quarantine.set(key, { code: checked.code, diagnostics: checked.diagnostics })
        continue
      }
      let record = frozenClone(table[key])
      if (record.activeRoundId !== null) {
        const recovery = recoverInterruptedRecord(record)
        if (!recovery.ok) {
          this.#quarantine.set(key, { code: recovery.code, diagnostics: recovery.diagnostics })
          continue
        }
        if (recovery.needed) {
          const persisted = await this.#persistLocked(key, recovery.record)
          if (!persisted.ok) {
            this.#quarantine.set(key, { code: 'RECOVERY_PERSIST_FAILED', diagnostics: persisted.diagnostics })
            continue
          }
          this.#recovered.push({ key, outcome: 'inconclusive' })
          record = persisted.record
        }
      }
      this.#records.set(key, record)
      this.#approvals.set(key, approvalSnapshot(record))
    }
  }

  async #safeUnitClose() {
    try { await this.#unit.close() } catch { /* the open failure is the reportable one */ }
  }

  #errorDiagnostics(error, fallbackCode) {
    if (error instanceof ReviewStoreError) {
      if (error.diagnostics.length) return error.diagnostics
      return freezeDiagnostics([diagnostic(error.code, '$', error.message)])
    }
    if (error instanceof ReviewContractError) {
      return freezeDiagnostics([diagnostic(error.code, error.path ?? '$', error.message)])
    }
    return freezeDiagnostics([diagnostic(fallbackCode, '$', 'Invalid review request')])
  }
}

/** Resolve the configured Host backend through the public storage hub. */
export function resolveReviewBackend(storage, name = 'json') {
  if (!storage || typeof storage !== 'object' || !storage.backend || typeof storage.backend.get !== 'function') {
    fail('STORE_UNAVAILABLE', 'The Host storage hub is unavailable')
  }
  if (typeof name !== 'string' || !name.trim()) fail('STORE_UNAVAILABLE', 'A named storage backend is required')
  let backend
  try {
    backend = storage.backend.get(name)
  } catch (error) {
    fail('STORE_UNAVAILABLE', 'The configured storage backend is not mounted', {
      cause: error,
      diagnostics: [diagnostic('STORE_UNAVAILABLE', '$', 'Backend lookup failed: ' + (error?.message ?? 'unknown error'))],
    })
  }
  if (!backend) {
    fail('STORE_UNAVAILABLE', 'The configured storage backend is not mounted', {
      diagnostics: [diagnostic('STORE_UNAVAILABLE', '$', 'No backend is registered under ' + name)],
    })
  }
  return backend
}

/** Open the Host-owned review store. The caller keeps ownership of the backend;
 * this store closes only the unit it opened.
 */
export async function openReviewStore(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('STORE_UNAVAILABLE', 'Expected store options')
  const backend = options.backend ?? (options.storage === undefined
    ? null
    : resolveReviewBackend(options.storage, options.backendName ?? 'json'))
  if (!backend || typeof backend !== 'object' || !backend.kv || typeof backend.kv.open !== 'function') {
    fail('STORE_UNAVAILABLE', 'The review storage backend does not expose the public KV facet')
  }
  let unit
  try {
    unit = await backend.kv.open(REVIEW_STORE_UNIT)
  } catch (error) {
    fail('STORE_UNAVAILABLE', 'The review KV unit could not be opened', {
      cause: error,
      diagnostics: [diagnostic(error?.code ?? 'STORE_UNAVAILABLE', '$', 'KV open failed: ' + (error?.message ?? 'unknown error'))],
    })
  }
  if (!unit || typeof unit !== 'object' ||
      typeof unit.loadAll !== 'function' || typeof unit.putRecord !== 'function' || typeof unit.close !== 'function') {
    fail('STORE_UNAVAILABLE', 'The opened KV unit does not implement the public read/write/close contract')
  }
  return ReviewStore.open(unit)
}
