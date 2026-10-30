/**
 * Required-only execution handoff and worker/worktree lease.
 *
 * The projection records workflow intent (plan/execute) but is deliberately
 * pure: a skill load can record execute, and that is still not an authorization.
 * This module is the Host-owned authority that turns a durable dual-review
 * approval into a revocable execution lease, and it is the only place a lease
 * can be checked:
 *
 *   - a lease is issued only for a synchronous request from the current author
 *     of the handoff; async/replayed/delegated callers cannot mint execute;
 *   - a required plan needs a persisted approval whose approved round is still
 *     the current approval, exact live raw and instruction digests, a matching
 *     policy hash and two complete OKAY lane receipts bound to that round;
 *   - the receipt view is deduplicated per round and refreshed for a new round;
 *   - \`bind-worktree\` verifies read-only git worktree membership of the same
 *     repository plus the instruction hash, then records the binding;
 *   - \`bootstrap\` cancels the previous handoff before it calls the scaffold
 *     function (never a shell), and then requires the review again;
 *   - after issuance the guard revalidates the instruction hash on every
 *     side-effect entry, so a legal status tick stays valid while an edited
 *     instruction revokes the lease immediately;
 *   - expiry is a pure comparison of explicit \`at\`/\`expiresAt\` fields. This
 *     module never reads the wall clock; a Host adapter may inject \`now\`.
 *
 * Ordinary (non-required) plans receive an ordinary lease after \`check\` and
 * never start a reviewer call. A missing enhanced review service leaves
 * ordinary/consult/plan behaviour untouched and makes required handoff fail
 * closed with an explicit code instead of falling back to a draft OKAY.
 *
 * @module dsh-ulw-plan/review-handoff
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseHandoffRequest } from './review-protocol.js'
import { computeInstructionSha256, createReviewArtifact } from './review-artifact.js'
import { artifactRoot, isUnderArtifactRoot } from './paths.js'
import { scaffold as defaultScaffold } from '../skills/ulw-plan/scripts/scaffold-plan.mjs'

/** Every action the Host handoff surface can select. */
export const HANDOFF_ACTIONS = Object.freeze(['check', 'bootstrap', 'bind-worktree'])

/** The exact lease fields a Host-verified execution authorization carries. */
export const HANDOFF_LEASE_FIELDS = Object.freeze([
  'handoffId', 'planSha256', 'instructionSha256', 'approvedRoundId', 'approvedSourceSha256', 'reviewedAt',
])

/** Stable refusal codes; every one names a next action. */
export const HANDOFF_CODES = Object.freeze([
  'HANDOFF_INVALID_REQUEST',
  'HANDOFF_NOT_SYNCHRONOUS',
  'HANDOFF_AUTHOR_REQUIRED',
  'HANDOFF_AUTHOR_MISMATCH',
  'HANDOFF_SOURCE_UNAVAILABLE',
  'HANDOFF_STORE_UNAVAILABLE',
  'HANDOFF_REVIEW_UNAVAILABLE',
  'HANDOFF_REVIEW_REQUIRED',
  'HANDOFF_NOT_APPROVED',
  'HANDOFF_APPROVAL_STALE',
  'HANDOFF_APPROVAL_UNPERSISTED',
  'HANDOFF_POLICY_MISMATCH',
  'HANDOFF_POLICY_UNBOUND',
  'HANDOFF_SELECTION_REQUIRED',
  'HANDOFF_STALE_SOURCE',
  'HANDOFF_RECEIPT_INVALID',
  'HANDOFF_LEASE_MISSING',
  'HANDOFF_LEASE_FORGED',
  'HANDOFF_LEASE_EXPIRED',
  'HANDOFF_LEASE_REVOKED',
  'HANDOFF_LEASE_OTHER_PLAN',
  'HANDOFF_LEASE_OTHER_SOURCE',
  'HANDOFF_WORKTREE_UNVERIFIED',
  'HANDOFF_WORKTREE_STALE',
  'HANDOFF_BOOTSTRAP_REFUSED',
  'HANDOFF_SCAFFOLD_FAILED',
  'HANDOFF_DELEGATE_REJECTED',
  'HANDOFF_ACTIVE_EXECUTE',
  'HANDOFF_CLOSED',
])

const DIGEST = /^[a-f0-9]{64}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const LANES = Object.freeze(['practical', 'adversarial'])
const FILE_TOOLS = new Set(['write', 'edit'])
const SAFE_TOOLS = new Set([
  'read', 'glob', 'grep', 'read_image', 'todo_write', 'ask_user_question',
  'create_goal', 'get_goal', 'update_goal', 'schedule_list', 'schedule_create',
  'schedule_update', 'schedule_delete', 'job_list', 'job_output', 'job_kill',
  'list_agents', 'send_message', 'interrupt_agent', 'web_search', 'web_fetch',
  'skill', 'present',
  // The tools that can open the gate must remain usable before the lease.
  'ulw_handoff', 'ulw_review', 'ulw_review_input',
])
const APPROVAL_NEXT = Object.freeze({
  required: 'start',
  preparing: 'start',
  in_flight: 'wait',
  changes_requested: 'review',
  stale: 'review',
  inconclusive: 'review',
  cancelled: 'review',
  stopped: 'review',
  approved: null,
})
const REFUSAL = 'ulw handoff: product writes, shell commands and implementation spawns are blocked'
const EXIT = 'Or run /ulw-mode off to leave the workflow.'

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const isDigest = value => typeof value === 'string' && DIGEST.test(value)
const isIdentifier = value => typeof value === 'string' && IDENTIFIER.test(value) && ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')
const messageOf = error => (error instanceof Error ? error.message : String(error))
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const diagnostic = (code, path, message) => ({ code, path, message })
const errorCode = (error, fallback) => {
  const code = error?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : fallback
}
const diagnosticsOf = (error, fallback) => {
  if (Array.isArray(error?.diagnostics) && error.diagnostics.length > 0) {
    return error.diagnostics.map(entry => ({
      code: typeof entry?.code === 'string' ? entry.code : fallback,
      path: typeof entry?.path === 'string' ? entry.path : '$',
      message: String(entry?.message ?? ''),
    }))
  }
  return [diagnostic(errorCode(error, fallback), typeof error?.path === 'string' ? error.path : '$', messageOf(error) || 'Invalid handoff operation')]
}
const refusal = (action, code, nextAction, extra = {}) => ({
  ok: false,
  action,
  outcome: extra.outcome ?? 'refused',
  code,
  nextAction,
  diagnostics: extra.diagnostics ?? [diagnostic(code, '$', extra.message ?? 'The handoff request was refused')],
  ...clone({ ...extra, diagnostics: undefined, outcome: undefined, message: undefined }),
})
const denialText = (state, code, nextAction) =>
  REFUSAL + ' (' + code + ', nextAction=' + nextAction + ') for ' + state.target + '. ' +
  'Required plans need two complete OKAY lane receipts and a persisted approved round: run the plan review ' +
  '(/ulw-review or ulw_review require/start/wait), then call ulw_handoff check. ' +
  'Use ulw_handoff bind-worktree to confirm a task worktree. ' + EXIT

/**
 * Pure lease shape/field validator. No IO and no clock: expiry is decided only
 * when the caller passes an explicit \`at\` timestamp.
 * @param lease - candidate lease.
 * @param current - optional explicit current facts (target, instructionSha256,
 *   approvedRoundId, approvedSourceSha256, at, revoked).
 * @returns \`{ ok, code, nextAction, lease }\`.
 */
export function validateHandoffLease(lease, current = {}) {
  if (lease === undefined || lease === null) {
    return { ok: false, code: 'HANDOFF_LEASE_MISSING', nextAction: 'check', lease: null }
  }
  if (!isPlainObject(lease)) return { ok: false, code: 'HANDOFF_LEASE_FORGED', nextAction: 'check', lease: null }
  for (const field of HANDOFF_LEASE_FIELDS) {
    if (field === 'approvedRoundId') continue
    if (field === 'approvedSourceSha256' && lease.approvedRoundId === null) continue
    const value = lease[field]
    if (field === 'handoffId' || field === 'approvedRoundId') {
      if (value !== null && !isIdentifier(value)) return { ok: false, code: 'HANDOFF_LEASE_FORGED', nextAction: 'check', lease: null }
    } else if (field === 'reviewedAt') {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) return { ok: false, code: 'HANDOFF_LEASE_FORGED', nextAction: 'check', lease: null }
    } else if (value !== null && !isDigest(value)) {
      return { ok: false, code: 'HANDOFF_LEASE_FORGED', nextAction: 'check', lease: null }
    }
  }
  if (!isIdentifier(lease.handoffId)) return { ok: false, code: 'HANDOFF_LEASE_FORGED', nextAction: 'check', lease: null }
  if (lease.expiresAt !== undefined && lease.expiresAt !== null && (!Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < 0)) {
    return { ok: false, code: 'HANDOFF_LEASE_FORGED', nextAction: 'check', lease: null }
  }
  if (current.revoked === true) return { ok: false, code: 'HANDOFF_LEASE_REVOKED', nextAction: 'check', lease }
  if (Number.isSafeInteger(current.at) && Number.isSafeInteger(lease.expiresAt) && current.at >= lease.expiresAt) {
    return { ok: false, code: 'HANDOFF_LEASE_EXPIRED', nextAction: 'check', lease }
  }
  if (typeof current.target === 'string' && typeof lease.target === 'string' && current.target !== lease.target) {
    return { ok: false, code: 'HANDOFF_LEASE_OTHER_PLAN', nextAction: 'check', lease }
  }
  if (isDigest(current.instructionSha256) && lease.instructionSha256 !== current.instructionSha256) {
    return { ok: false, code: 'HANDOFF_STALE_SOURCE', nextAction: 'review', lease }
  }
  if (current.approvedRoundId !== undefined && lease.approvedRoundId !== current.approvedRoundId) {
    return { ok: false, code: 'HANDOFF_APPROVAL_STALE', nextAction: 'check', lease }
  }
  if (current.approvedSourceSha256 !== undefined && lease.approvedSourceSha256 !== current.approvedSourceSha256) {
    return { ok: false, code: 'HANDOFF_LEASE_OTHER_SOURCE', nextAction: 'check', lease }
  }
  return { ok: true, code: null, nextAction: 'execute', lease }
}

/** Whether a lease carries the exact required shape (no current facts). */
export function isHandoffLease(value) {
  return validateHandoffLease(value).ok
}

/** Wrap the durable review store as the handoff's approval seam.
 * The persisted flag is derived by cross-checking the cached approval against a
 * fresh validated record read, so an in-memory optimistic snapshot cannot grant
 * a lease on its own. */
export function createStoreApprovalSource(store) {
  if (!store || typeof store.status !== 'function' || typeof store.approval !== 'function') {
    throw new TypeError('createStoreApprovalSource requires the review store with status() and approval()')
  }
  return Object.freeze({
    approval(identity) {
      let status, approval
      try {
        status = store.status(identity)
        approval = store.approval(identity)
      } catch (error) {
        return { ok: false, code: 'HANDOFF_STORE_UNAVAILABLE', diagnostics: diagnosticsOf(error, 'HANDOFF_STORE_UNAVAILABLE') }
      }
      if (!status || status.ok !== true) {
        return {
          ok: false,
          code: typeof status?.code === 'string' ? status.code : 'HANDOFF_STORE_UNAVAILABLE',
          diagnostics: Array.isArray(status?.diagnostics) && status.diagnostics.length
            ? status.diagnostics
            : [diagnostic('HANDOFF_STORE_UNAVAILABLE', '$', 'The durable review record could not be read')],
        }
      }
      if (!approval || approval.ok !== true) {
        return {
          ok: false,
          code: typeof approval?.code === 'string' ? approval.code : 'HANDOFF_STORE_UNAVAILABLE',
          diagnostics: Array.isArray(approval?.diagnostics) && approval.diagnostics.length
            ? approval.diagnostics
            : [diagnostic('HANDOFF_STORE_UNAVAILABLE', '$', 'The handoff-facing approval could not be read')],
        }
      }
      const sameApproval = sameSnapshot(status.approval, approval)
      const persisted = status.exists === true && status.record?.state === 'approved' &&
        status.approval?.approved === true && sameApproval && status.record?.revision === approval.revision
      return {
        ...approval,
        state: status.record?.state ?? approval.state,
        persisted,
        nextAction: approval.state === 'approved' ? null : undefined,
      }
    },
  })
}

function normalizeTarget(workspace, target) {
  if (!target.startsWith('/')) return target
  const rel = relative(workspace, target)
  if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}
const slugOf = target => /^\.dsh\/ulw\/plans\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(target)?.[1] ?? null
const sessionIdOf = exec => {
  const session = exec?.agent?.session
  const id = session?.header?.id ?? session?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}
const sourceKeyOf = (workspace, target) => workspace + '\u0000' + target
const nextActionForApproval = approval => {
  if (typeof approval?.nextAction === 'string' && approval.nextAction.length > 0) return approval.nextAction
  return APPROVAL_NEXT[approval?.state] ?? 'review'
}
const SNAPSHOT_KEYS = Object.freeze(['approved', 'required', 'state', 'roundId', 'revision', 'receipts', 'source', 'policy'])
const sameSnapshot = (a, b) => SNAPSHOT_KEYS.every(key => JSON.stringify(a?.[key] ?? null) === JSON.stringify(b?.[key] ?? null))
function verifyReceipts(approval, source) {
  const receipts = approval?.receipts
  if (!isPlainObject(receipts)) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
  for (const lane of LANES) {
    const receipt = receipts[lane]
    if (!isPlainObject(receipt)) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
    if (receipt.lane !== lane) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
    if (receipt.roundId !== approval.roundId) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
    if (receipt.verdict !== 'OKAY' || receipt.stopReason !== 'completed') return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
    if (receipt.planSha256 !== source.planSha256) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
    if (receipt.instructionSha256 !== source.instructionSha256) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
    if (receipt.coverage?.complete !== true) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
    if (receipt.coverage.planSha256 !== undefined && receipt.coverage.planSha256 !== source.planSha256) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
    if (receipt.coverage.instructionSha256 !== undefined && receipt.coverage.instructionSha256 !== source.instructionSha256) return { ok: false, code: 'HANDOFF_RECEIPT_INVALID' }
  }
  return { ok: true, code: null }
}
function receiptView(approval, source, at) {
  return {
    roundId: approval.roundId,
    source: { planSha256: source.planSha256, instructionSha256: source.instructionSha256 },
    capturedAt: at,
    lanes: LANES.map(lane => ({
      lane,
      verdict: approval.receipts[lane].verdict,
      planSha256: approval.receipts[lane].planSha256,
      instructionSha256: approval.receipts[lane].instructionSha256,
    })),
  }
}
const isUnderPlanOrDraft = (cwd, target) => {
  if (typeof target !== 'string' || target.trim() === '') return false
  if (!isUnderArtifactRoot(cwd, target)) return false
  const root = artifactRoot(cwd)
  const rel = relative(root, resolve(cwd, target)).split(sep).join('/')
  return rel.startsWith('plans/') || rel.startsWith('drafts/')
}

function defaultReadSourceSync(workspace, target) {
  try {
    const path = target.startsWith('/') ? target : resolve(workspace, target)
    const bytes = readFileSync(path)
    return { planSha256: hashBytes(bytes), instructionSha256: computeInstructionSha256(bytes) }
  } catch {
    return null
  }
}
async function defaultCapture({ workspace, target }) {
  const artifact = await createReviewArtifact({ workspace, target })
  return { planSha256: artifact.sha256, instructionSha256: artifact.instructionSha256, totalBytes: artifact.totalBytes }
}
function gitRead(cwd, args) {
  return new Promise(resolvePromise => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => resolvePromise(error ? null : stdout))
  })
}
async function defaultWorktreeMembership({ workspace, worktreePath }) {
  const top = await gitRead(workspace, ['rev-parse', '--show-toplevel'])
  const targetTop = await gitRead(worktreePath, ['rev-parse', '--show-toplevel'])
  if (top === null || targetTop === null) return { ok: false }
  if (resolve(top.trim()) !== resolve(workspace) || resolve(targetTop.trim()) !== resolve(worktreePath)) return { ok: false }
  const common = await gitRead(workspace, ['rev-parse', '--git-common-dir'])
  const targetCommon = await gitRead(worktreePath, ['rev-parse', '--git-common-dir'])
  if (common === null || targetCommon === null) return { ok: false }
  const commonDir = resolve(workspace, common.trim())
  const targetCommonDir = resolve(worktreePath, targetCommon.trim())
  if (commonDir !== targetCommonDir) return { ok: false }
  const list = await gitRead(workspace, ['worktree', 'list', '--porcelain'])
  if (list === null) return { ok: false }
  const members = list.split('\n').filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)))
  if (!members.some(entry => entry === resolve(worktreePath))) return { ok: false }
  return { ok: true, repoRoot: resolve(top.trim()), commonDir, members }
}
async function draftRequiresReview(workspace, target) {
  const slug = slugOf(target)
  if (slug === null) return false
  try {
    const text = await readFile(join(workspace, '.dsh', 'ulw', 'drafts', slug + '.md'), 'utf8')
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!front) return false
    return /^review_required:[ \t]*true[ \t]*$/m.test(front[1])
  } catch {
    return false
  }
}

/**
 * Build one injection-friendly handoff authority.
 * @param options - required \`workspace\` (canonical absolute); optional
 *   \`review\` ({approval(identity)}), \`capture\`, \`readSourceSync\`,
 *   \`scaffold\`, \`worktreeMembership\`, \`policySha256\`, \`leaseTtlMs\`,
 *   \`now\` (\`() => integer\`; absence keeps the module clock-free).
 * @returns a frozen service with check/bootstrap/bindWorktree/assertLease/
 *   revoke/delegate/reviewAllowed/guard/stateForSession/close.
 */
export function createHandoffService(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createHandoffService requires an options object')
  const workspace = options.workspace
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || resolve(workspace) !== workspace) {
    throw new TypeError('createHandoffService requires a canonical absolute workspace')
  }
  if (options.policySha256 !== undefined && !isDigest(options.policySha256)) {
    throw new TypeError('policySha256 must be a raw SHA-256 hex digest')
  }
  if (options.leaseTtlMs !== undefined && options.leaseTtlMs !== null && (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs < 0)) {
    throw new TypeError('leaseTtlMs must be a nonnegative integer')
  }
  if (options.review !== undefined && options.review !== null && typeof options.review.approval !== 'function') {
    throw new TypeError('review must expose approval(identity)')
  }
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('now must be a function')
  const review = options.review ?? null
  const captureSource = options.capture ?? defaultCapture
  const readSourceSync = options.readSourceSync ?? defaultReadSourceSync
  const scaffoldFn = options.scaffold ?? defaultScaffold
  const worktreeMembership = options.worktreeMembership ?? defaultWorktreeMembership
  const policySha256 = options.policySha256 ?? null
  const leaseTtlMs = options.leaseTtlMs ?? null
  const now = options.now ?? null

  const states = new Map()
  const bySource = new Map()
  const sessionSelections = new Map()
  let seq = 0
  let closed = false

  function atOf(context) {
    if (Number.isSafeInteger(context?.at) && context.at >= 0) return context.at
    if (now !== null) {
      const value = now()
      if (Number.isSafeInteger(value) && value >= 0) return value
    }
    return null
  }
  function callerContext(context) {
    if (!isPlainObject(context)) return { ok: false, code: 'HANDOFF_INVALID_REQUEST' }
    if (context.synchronous !== true) return { ok: false, code: 'HANDOFF_NOT_SYNCHRONOUS' }
    const sessionId = context.author?.sessionId
    if (typeof sessionId !== 'string' || !isIdentifier(sessionId)) return { ok: false, code: 'HANDOFF_AUTHOR_REQUIRED' }
    return { ok: true, sessionId, at: atOf(context) }
  }
  function parseAction(action, request) {
    try {
      if (isPlainObject(request) && Object.hasOwn(request, 'action') && request.action !== action) {
        return { ok: false, diagnostics: [diagnostic('HANDOFF_INVALID_REQUEST', '$.action', 'Request action does not match the invoked handoff method')] }
      }
      const input = request === undefined || request === null ? { action } : { ...request, action }
      const parsed = parseHandoffRequest(input)
      return { ok: true, parsed }
    } catch (error) {
      return { ok: false, diagnostics: diagnosticsOf(error, 'HANDOFF_INVALID_REQUEST') }
    }
  }
  function stateFor(sourceKey) {
    return bySource.get(sourceKey) ?? null
  }
  function ensureState(sourceKey, sessionId, target) {
    let state = bySource.get(sourceKey)
    if (state && (state.status === 'revoked' || state.status === 'cancelled')) state = null
    if (state) return state
    state = {
      seq: ++seq,
      handoffId: 'handoff-' + randomUUID(),
      workspace,
      target,
      sourceKey,
      sessions: new Set([sessionId]),
      required: null,
      status: 'checked',
      lease: null,
      approvalToken: null,
      approvalState: null,
      receipt: null,
      binding: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: null,
      updatedAt: null,
    }
    states.set(state.handoffId, state)
    bySource.set(sourceKey, state)
    return state
  }
  function authorizeState(state, sessionId) {
    return state.sessions.has(sessionId)
  }
  function revokeState(state, reason, at) {
    state.status = 'revoked'
    state.lease = null
    state.revokedAt = at
    state.revokedReason = reason
    state.updatedAt = at
  }
  function selectedStateFor(sessionId) {
    const handoffId = sessionSelections.get(sessionId)
    if (handoffId === undefined) return null
    return states.get(handoffId) ?? null
  }
  function currentStateForSession(sessionId) {
    // A session that once selected a required plan stays pinned to it: a decoy
    // ordinary target can never become the authorizing state. Children have no
    // selection, so the fallback still prefers an active required state over a
    // newer ordinary one.
    const selected = selectedStateFor(sessionId)
    if (selected !== null) return selected
    let newest = null
    let requiredActive = null
    for (const state of bySource.values()) {
      if (!state.sessions.has(sessionId)) continue
      if (newest === null || state.seq > newest.seq) newest = state
      const active = state.status !== 'revoked' && state.status !== 'cancelled'
      if (state.required === true && active && (requiredActive === null || state.seq > requiredActive.seq)) requiredActive = state
    }
    return requiredActive ?? newest
  }
  async function readApproval(target) {
    if (review === null) return { ok: true, exists: false }
    let out
    try {
      out = await review.approval({ workspace, target })
    } catch (error) {
      return { ok: false, code: 'HANDOFF_STORE_UNAVAILABLE', diagnostics: diagnosticsOf(error, 'HANDOFF_STORE_UNAVAILABLE') }
    }
    if (!isPlainObject(out)) return { ok: false, code: 'HANDOFF_STORE_UNAVAILABLE', diagnostics: [diagnostic('HANDOFF_STORE_UNAVAILABLE', '$', 'The review approval seam returned no record')] }
    if (out.ok === false) {
      return {
        ok: false,
        code: typeof out.code === 'string' ? out.code : 'HANDOFF_STORE_UNAVAILABLE',
        diagnostics: Array.isArray(out.diagnostics) && out.diagnostics.length
          ? out.diagnostics
          : [diagnostic('HANDOFF_STORE_UNAVAILABLE', '$', 'The durable review approval is unavailable')],
      }
    }
    return out
  }
  async function capture(target) {
    try {
      const value = await captureSource({ workspace, target })
      if (!isPlainObject(value) || !isDigest(value.planSha256) || !isDigest(value.instructionSha256)) {
        return { ok: false, diagnostics: [diagnostic('HANDOFF_SOURCE_UNAVAILABLE', '$', 'The live plan source returned no valid digests')] }
      }
      return { ok: true, source: value }
    } catch (error) {
      return { ok: false, diagnostics: diagnosticsOf(error, 'HANDOFF_SOURCE_UNAVAILABLE') }
    }
  }
  function makeLease(state, source, approval, required, at) {
    const expiresAt = Number.isSafeInteger(at) && Number.isSafeInteger(leaseTtlMs) ? at + leaseTtlMs : null
    return {
      handoffId: state.handoffId,
      planSha256: source.planSha256,
      instructionSha256: source.instructionSha256,
      approvedRoundId: required ? approval.roundId : null,
      approvedSourceSha256: required ? approval.source.planSha256 : null,
      reviewedAt: at,
      expiresAt,
      required,
      target: state.target,
      workspace,
    }
  }
  function assertIssued(state, lease) {
    if (!state.lease || !isPlainObject(lease)) return false
    for (const field of HANDOFF_LEASE_FIELDS) {
      if (lease[field] !== state.lease[field]) return false
    }
    if ((lease.target ?? null) !== (state.lease.target ?? null)) return false
    if ((lease.expiresAt ?? null) !== (state.lease.expiresAt ?? null)) return false
    return true
  }
  async function captureWorktree(target, worktreePath) {
    try {
      const value = await captureSource({ workspace: worktreePath, target })
      if (!isPlainObject(value) || !isDigest(value.instructionSha256)) return null
      return value
    } catch {
      return null
    }
  }

  async function check(request, context) {
    if (closed) return refusal('check', 'HANDOFF_CLOSED', 'check')
    const parsed = parseAction('check', request)
    if (!parsed.ok) return refusal('check', 'HANDOFF_INVALID_REQUEST', 'check', { diagnostics: parsed.diagnostics })
    const caller = callerContext(context)
    if (!caller.ok) return refusal('check', caller.code, 'check')
    const target = normalizeTarget(workspace, parsed.parsed.target)
    if (target === null) return refusal('check', 'HANDOFF_INVALID_REQUEST', 'check', { diagnostics: [diagnostic('HANDOFF_INVALID_REQUEST', '$.target', 'Target must stay inside the service workspace')] })
    const selected = selectedStateFor(caller.sessionId)
    if (selected !== null && selected.target !== target) {
      return refusal('check', 'HANDOFF_SELECTION_REQUIRED', 'review', {
        target, required: selected.required === true, selectedTarget: selected.target,
        diagnostics: [diagnostic('HANDOFF_SELECTION_REQUIRED', '$.target', 'This session is pinned to the selected required plan ' + selected.target)],
      })
    }
    const sourceKey = sourceKeyOf(workspace, target)
    let state = stateFor(sourceKey)
    if (state && !authorizeState(state, caller.sessionId)) {
      return refusal('check', 'HANDOFF_AUTHOR_MISMATCH', 'check', { target, required: state.required })
    }
    state = ensureState(sourceKey, caller.sessionId, target)
    if (!state.sessions.has(caller.sessionId)) return refusal('check', 'HANDOFF_AUTHOR_MISMATCH', 'check', { target })
    state.updatedAt = caller.at
    if (state.createdAt === null) state.createdAt = caller.at

    const first = await capture(target)
    if (!first.ok) {
      state.required = state.required ?? false
      return refusal('check', 'HANDOFF_SOURCE_UNAVAILABLE', 'check', { target, required: state.required, diagnostics: first.diagnostics })
    }
    const source = first.source
    const approval = await readApproval(target)
    if (!approval.ok) {
      return refusal('check', approval.code, 'check', { target, required: state.required ?? false, diagnostics: approval.diagnostics })
    }
    const exists = approval.exists === true
    const legacyRequired = !exists && await draftRequiresReview(workspace, target)
    const required = exists ? approval.required === true : legacyRequired
    state.required = required
    if (required) sessionSelections.set(caller.sessionId, state.handoffId)

    if (!required) {
      if (selected !== null) {
        return refusal('check', 'HANDOFF_SELECTION_REQUIRED', 'review', {
          target, required: true, selectedTarget: selected.target,
          diagnostics: [diagnostic('HANDOFF_SELECTION_REQUIRED', '$.target', 'An ordinary lease cannot supersede the selected required plan')],
        })
      }
      const lease = makeLease(state, source, approval, false, caller.at)
      state.lease = lease
      state.status = 'leased'
      state.approvalToken = null
      state.approvalState = exists ? (approval.state ?? null) : null
      return {
        ok: true,
        action: 'check',
        outcome: 'ordinary_lease',
        code: null,
        nextAction: 'execute',
        target,
        handoffId: state.handoffId,
        required: false,
        lease,
        receipt: null,
        approval: { exists, approved: false, state: state.approvalState, roundId: null },
        diagnostics: [],
      }
    }
    if (review === null && !exists) {
      return refusal('check', 'HANDOFF_REVIEW_UNAVAILABLE', 'review', {
        target, required: true,
        diagnostics: [diagnostic('HANDOFF_REVIEW_UNAVAILABLE', '$', 'Required plans need the enhanced dual-review service; no local draft approval is authoritative')],
      })
    }
    if (!exists) {
      return refusal('check', 'HANDOFF_REVIEW_REQUIRED', 'review', {
        target, required: true,
        diagnostics: [diagnostic('HANDOFF_REVIEW_REQUIRED', '$', 'The plan declares review_required but no persisted review requirement exists yet')],
      })
    }
    if (approval.approved !== true || approval.state !== 'approved' || !isIdentifier(approval.roundId)) {
      return refusal('check', 'HANDOFF_NOT_APPROVED', nextActionForApproval(approval), {
        target, required: true, state: approval.state ?? null,
        diagnostics: [diagnostic('HANDOFF_NOT_APPROVED', '$.approval', 'The persisted review is not approved; requirement state is ' + (approval.state ?? 'unknown'))],
      })
    }
    if (approval.nextAction !== undefined && approval.nextAction !== null) {
      return refusal('check', 'HANDOFF_APPROVAL_STALE', 'review', {
        target, required: true, state: approval.state,
        diagnostics: [diagnostic('HANDOFF_APPROVAL_STALE', '$.nextAction', 'An approved record must not ask for another step')],
      })
    }
    if (policySha256 === null) {
      return refusal('check', 'HANDOFF_POLICY_UNBOUND', 'review', {
        target, required: true, state: approval.state,
        diagnostics: [diagnostic('HANDOFF_POLICY_UNBOUND', '$.policy.policySha256', 'A required lease needs a configured review policy hash to compare')],
      })
    }
    if (approval.policy?.policySha256 !== policySha256) {
      return refusal('check', 'HANDOFF_POLICY_MISMATCH', 'review', {
        target, required: true, state: approval.state,
        diagnostics: [diagnostic('HANDOFF_POLICY_MISMATCH', '$.policy.policySha256', 'The approved review policy differs from this handoff policy')],
      })
    }
    if (approval.source?.planSha256 !== source.planSha256 || approval.source?.instructionSha256 !== source.instructionSha256) {
      return refusal('check', 'HANDOFF_STALE_SOURCE', 'review', {
        target, required: true, state: approval.state,
        diagnostics: [diagnostic('HANDOFF_STALE_SOURCE', '$.source', 'The live plan bytes differ from the approved source; re-review is required')],
      })
    }
    const token = approval.roundId + '@' + (Number.isSafeInteger(approval.revision) ? approval.revision : '?')
    const isNewApproval = state.approvalToken !== token
    if (isNewApproval && approval.persisted !== true) {
      return refusal('check', 'HANDOFF_APPROVAL_UNPERSISTED', 'review', {
        target, required: true, state: approval.state,
        diagnostics: [diagnostic('HANDOFF_APPROVAL_UNPERSISTED', '$.persisted', 'A new approval must come from a persisted durable record')],
      })
    }
    if (isNewApproval && approval.changed === false) {
      return refusal('check', 'HANDOFF_APPROVAL_UNPERSISTED', 'review', {
        target, required: true, state: approval.state,
        diagnostics: [diagnostic('HANDOFF_APPROVAL_UNPERSISTED', '$.changed', 'A new approval must report a changed durable transition')],
      })
    }
    const receipts = verifyReceipts(approval, source)
    if (!receipts.ok) {
      return refusal('check', 'HANDOFF_RECEIPT_INVALID', 'review', {
        target, required: true, state: approval.state,
        diagnostics: [diagnostic('HANDOFF_RECEIPT_INVALID', '$.receipts', 'Both lane receipts must bind the approved round and the complete reviewed source')],
      })
    }
    const second = await capture(target)
    if (!second.ok || second.source.planSha256 !== source.planSha256 || second.source.instructionSha256 !== source.instructionSha256) {
      return refusal('check', 'HANDOFF_STALE_SOURCE', 'review', {
        target, required: true, state: approval.state,
        diagnostics: [diagnostic('HANDOFF_STALE_SOURCE', '$.source', 'The live plan changed while the lease was being verified')],
      })
    }
    const lease = makeLease(state, source, approval, true, caller.at)
    const receipt = state.receipt?.roundId === approval.roundId ? state.receipt : receiptView(approval, source, caller.at)
    state.lease = lease
    state.status = state.binding === null ? 'leased' : 'bound'
    state.approvalToken = token
    state.approvalState = approval.state
    state.receipt = receipt
    return {
      ok: true,
      action: 'check',
      outcome: 'required_lease',
      code: null,
      nextAction: 'execute',
      target,
      handoffId: state.handoffId,
      required: true,
      lease,
      receipt,
      approval: { exists: true, approved: true, state: approval.state, roundId: approval.roundId, revision: approval.revision ?? null },
      diagnostics: [],
    }
  }

  async function bootstrap(request, context) {
    if (closed) return refusal('bootstrap', 'HANDOFF_CLOSED', 'check')
    const parsed = parseAction('bootstrap', request)
    if (!parsed.ok) return refusal('bootstrap', 'HANDOFF_INVALID_REQUEST', 'check', { diagnostics: parsed.diagnostics })
    const caller = callerContext(context)
    if (!caller.ok) return refusal('bootstrap', caller.code, 'check')
    const target = normalizeTarget(workspace, parsed.parsed.target)
    if (target === null) return refusal('bootstrap', 'HANDOFF_INVALID_REQUEST', 'check', { diagnostics: [diagnostic('HANDOFF_INVALID_REQUEST', '$.target', 'Target must stay inside the service workspace')] })
    const selected = selectedStateFor(caller.sessionId)
    if (selected !== null && selected.target !== target) {
      return refusal('bootstrap', 'HANDOFF_SELECTION_REQUIRED', 'review', {
        target, required: selected.required === true, selectedTarget: selected.target,
        diagnostics: [diagnostic('HANDOFF_SELECTION_REQUIRED', '$.target', 'This session is pinned to the selected required plan ' + selected.target)],
      })
    }
    const slug = slugOf(target)
    if (slug === null) return refusal('bootstrap', 'HANDOFF_INVALID_REQUEST', 'check', { diagnostics: [diagnostic('HANDOFF_INVALID_REQUEST', '$.target', 'Bootstrap needs a canonical plan slug')] })
    const sourceKey = sourceKeyOf(workspace, target)
    const prior = stateFor(sourceKey)
    if (prior && !authorizeState(prior, caller.sessionId)) return refusal('bootstrap', 'HANDOFF_AUTHOR_MISMATCH', 'check', { target })
    const approval = await readApproval(target)
    if (!approval.ok) return refusal('bootstrap', approval.code, 'check', { target, diagnostics: approval.diagnostics })
    const exists = approval.exists === true
    const trustedRequired = exists && approval.required === true
    if (trustedRequired && context.reviewRequired === false) {
      return refusal('bootstrap', 'HANDOFF_BOOTSTRAP_REFUSED', 'review', {
        target, required: true,
        diagnostics: [diagnostic('HANDOFF_BOOTSTRAP_REFUSED', '$.reviewRequired', 'A trusted required record cannot be cleared by bootstrap')],
      })
    }
    const desired = context.reviewRequired === true || trustedRequired || (!exists && await draftRequiresReview(workspace, target))
    let cancelledHandoffId = null
    if (prior && prior.status !== 'revoked' && prior.status !== 'cancelled') {
      revokeState(prior, 'bootstrap', caller.at)
      cancelledHandoffId = prior.handoffId
    }
    const state = ensureState(sourceKey, caller.sessionId, target)
    if (!state.sessions.has(caller.sessionId)) return refusal('bootstrap', 'HANDOFF_AUTHOR_MISMATCH', 'check', { target })
    state.required = desired
    state.status = 'bootstrap'
    state.lease = null
    if (desired) sessionSelections.set(caller.sessionId, state.handoffId)
    state.updatedAt = caller.at
    if (state.createdAt === null) state.createdAt = caller.at
    try {
      await mkdir(dirname(join(workspace, target)), { recursive: true })
      const results = await scaffoldFn(workspace, {
        slug,
        intent: typeof context.intent === 'string' && context.intent.length > 0 ? context.intent : 'clear',
        reset: context.reset === true,
        force: context.force === true,
        draftOnly: context.draftOnly === true,
        reviewRequired: desired,
      })
      const after = await draftRequiresReview(workspace, target)
      if (after) state.required = true
      return {
        ok: true,
        action: 'bootstrap',
        outcome: 'bootstrapped',
        code: null,
        nextAction: state.required ? 'review' : 'check',
        target,
        handoffId: state.handoffId,
        required: state.required,
        lease: null,
        scaffold: Array.isArray(results) ? results : [],
        cancelledHandoffId,
        diagnostics: [],
      }
    } catch (error) {
      return refusal('bootstrap', 'HANDOFF_SCAFFOLD_FAILED', state.required ? 'review' : 'check', {
        target, required: state.required, cancelledHandoffId,
        diagnostics: diagnosticsOf(error, 'HANDOFF_SCAFFOLD_FAILED'),
      })
    }
  }

  function leaseFailure(code, nextAction, lease, extra = {}) {
    return {
      ok: false,
      code,
      nextAction,
      lease: lease ?? null,
      diagnostics: extra.diagnostics ?? [diagnostic(code, typeof extra.path === 'string' ? extra.path : '$', extra.message ?? 'The execution lease is not valid')],
    }
  }
  async function assertLease(lease, context = {}) {
    if (closed) return leaseFailure('HANDOFF_CLOSED', 'check', null)
    const shape = validateHandoffLease(lease, { at: context?.at })
    if (!shape.ok) return shape.diagnostics ? shape : leaseFailure(shape.code, shape.nextAction, shape.lease)
    const state = states.get(lease.handoffId)
    if (!state) return leaseFailure('HANDOFF_LEASE_FORGED', 'check', lease)
    if (state.status === 'revoked' || state.status === 'cancelled') {
      return leaseFailure('HANDOFF_LEASE_REVOKED', 'check', lease)
    }
    if (!assertIssued(state, lease)) {
      if (state.lease !== null && lease.approvedRoundId !== state.lease.approvedRoundId) {
        return leaseFailure('HANDOFF_APPROVAL_STALE', 'check', lease)
      }
      return leaseFailure('HANDOFF_LEASE_FORGED', 'check', lease)
    }
    const target = typeof context?.target === 'string' ? context.target : state.target
    const pure = validateHandoffLease(state.lease, {
      at: context?.at,
      target,
      instructionSha256: context?.current?.instructionSha256,
      approvedRoundId: context?.current?.approvedRoundId,
      approvedSourceSha256: context?.current?.approvedSourceSha256,
    })
    if (!pure.ok) return leaseFailure(pure.code, pure.nextAction, lease)
    if (state.lease.required === true) {
      const approval = await readApproval(state.target)
      if (!approval.ok) return leaseFailure(approval.code, 'check', lease, { diagnostics: approval.diagnostics })
      if (approval.exists !== true || approval.approved !== true || approval.state !== 'approved' || approval.roundId !== lease.approvedRoundId) {
        return leaseFailure('HANDOFF_APPROVAL_STALE', 'check', lease)
      }
      if (approval.source?.planSha256 !== lease.approvedSourceSha256) {
        return leaseFailure('HANDOFF_LEASE_OTHER_SOURCE', 'check', lease)
      }
    }
    let current = context?.current
    if (!isPlainObject(current) || !isDigest(current.instructionSha256)) {
      const captured = await capture(state.target)
      if (!captured.ok) return leaseFailure('HANDOFF_STALE_SOURCE', 'review', lease, { diagnostics: captured.diagnostics })
      current = captured.source
    }
    if (current.instructionSha256 !== lease.instructionSha256) {
      return leaseFailure('HANDOFF_STALE_SOURCE', 'review', lease)
    }
    if (state.status === 'revoked' || state.status === 'cancelled') {
      return leaseFailure('HANDOFF_LEASE_REVOKED', 'check', lease)
    }
    return { ok: true, code: null, nextAction: 'execute', lease }
  }

  async function bindWorktree(request, context) {
    if (closed) return refusal('bind-worktree', 'HANDOFF_CLOSED', 'check')
    const parsed = parseAction('bind-worktree', request)
    if (!parsed.ok) return refusal('bind-worktree', 'HANDOFF_INVALID_REQUEST', 'check', { diagnostics: parsed.diagnostics })
    const caller = callerContext(context)
    if (!caller.ok) return refusal('bind-worktree', caller.code, 'check')
    const target = normalizeTarget(workspace, parsed.parsed.target)
    if (target === null) return refusal('bind-worktree', 'HANDOFF_INVALID_REQUEST', 'check', { diagnostics: [diagnostic('HANDOFF_INVALID_REQUEST', '$.target', 'Target must stay inside the service workspace')] })
    const selected = selectedStateFor(caller.sessionId)
    if (selected !== null && selected.target !== target) {
      return refusal('bind-worktree', 'HANDOFF_SELECTION_REQUIRED', 'review', {
        target, required: selected.required === true, selectedTarget: selected.target,
        diagnostics: [diagnostic('HANDOFF_SELECTION_REQUIRED', '$.target', 'This session is pinned to the selected required plan ' + selected.target)],
      })
    }
    const worktreePath = parsed.parsed.worktreePath
    const state = stateFor(sourceKeyOf(workspace, target))
    if (!state) return refusal('bind-worktree', 'HANDOFF_LEASE_MISSING', 'check', { target })
    if (!authorizeState(state, caller.sessionId)) return refusal('bind-worktree', 'HANDOFF_AUTHOR_MISMATCH', 'check', { target })
    if (!state.lease) return refusal('bind-worktree', 'HANDOFF_LEASE_MISSING', 'check', { target })
    const checked = await assertLease(state.lease, { at: caller.at, target })
    if (!checked.ok) return refusal('bind-worktree', checked.code, checked.nextAction, { target, diagnostics: checked.diagnostics })
    let membership
    try {
      membership = await worktreeMembership({ workspace, worktreePath })
    } catch {
      membership = { ok: false }
    }
    if (!isPlainObject(membership) || membership.ok !== true) {
      return refusal('bind-worktree', 'HANDOFF_WORKTREE_UNVERIFIED', 'bind-worktree', {
        target,
        diagnostics: [diagnostic('HANDOFF_WORKTREE_UNVERIFIED', '$.worktreePath', 'The path is not a read-only git worktree of this repository')],
      })
    }
    const worktreeSource = await captureWorktree(target, worktreePath)
    if (worktreeSource === null) {
      return refusal('bind-worktree', 'HANDOFF_WORKTREE_STALE', 'review', {
        target,
        diagnostics: [diagnostic('HANDOFF_WORKTREE_STALE', '$.worktreePath', 'The worktree plan could not be captured')],
      })
    }
    if (worktreeSource.instructionSha256 !== state.lease.instructionSha256) {
      return refusal('bind-worktree', 'HANDOFF_WORKTREE_STALE', 'review', {
        target,
        diagnostics: [diagnostic('HANDOFF_WORKTREE_STALE', '$.worktreePath', 'The worktree plan instruction differs from the leased source')],
      })
    }
    const reused = state.binding?.worktreePath === worktreePath
    state.binding = {
      worktreePath,
      repoRoot: typeof membership.repoRoot === 'string' ? membership.repoRoot : null,
      commonDir: typeof membership.commonDir === 'string' ? membership.commonDir : null,
      instructionSha256: worktreeSource.instructionSha256,
      boundAt: caller.at,
    }
    state.status = 'bound'
    state.updatedAt = caller.at
    return {
      ok: true,
      action: 'bind-worktree',
      outcome: reused ? 'worktree_reused' : 'worktree_bound',
      code: null,
      nextAction: 'execute',
      target,
      handoffId: state.handoffId,
      required: state.required === true,
      lease: state.lease,
      binding: clone(state.binding),
      diagnostics: [],
    }
  }

  async function revoke(handoffId, context = {}) {
    if (closed) return refusal('revoke', 'HANDOFF_CLOSED', 'check')
    const state = typeof handoffId === 'string' ? states.get(handoffId) : undefined
    if (!state) return refusal('revoke', 'HANDOFF_LEASE_MISSING', 'check')
    const host = context?.host === true
    if (!host) {
      const caller = callerContext(context)
      if (!caller.ok) return refusal('revoke', caller.code, 'check')
      if (!authorizeState(state, caller.sessionId)) return refusal('revoke', 'HANDOFF_AUTHOR_MISMATCH', 'check')
    }
    revokeState(state, 'revoked', Number.isSafeInteger(context?.at) ? context.at : atOf(context ?? {}))
    return { ok: true, action: 'revoke', outcome: 'revoked', code: null, nextAction: 'check', handoffId, diagnostics: [] }
  }

  async function delegate(handoffId, context) {
    if (closed) return refusal('delegate', 'HANDOFF_CLOSED', 'check')
    const state = typeof handoffId === 'string' ? states.get(handoffId) : undefined
    if (!state) return refusal('delegate', 'HANDOFF_LEASE_MISSING', 'check')
    const caller = callerContext(context)
    if (!caller.ok) return refusal('delegate', caller.code, 'check')
    if (!authorizeState(state, caller.sessionId)) return refusal('delegate', 'HANDOFF_AUTHOR_MISMATCH', 'check')
    if (!state.lease) return refusal('delegate', 'HANDOFF_LEASE_MISSING', 'check', { target: state.target })
    const checked = await assertLease(state.lease, { at: caller.at, target: state.target })
    if (!checked.ok) return refusal('delegate', checked.code, checked.nextAction, { target: state.target, diagnostics: checked.diagnostics })
    const children = Array.isArray(context.children) ? [...new Set(context.children)] : []
    if (children.length === 0 || children.length > 16 || children.some(id => typeof id !== 'string' || !isIdentifier(id))) {
      return refusal('delegate', 'HANDOFF_DELEGATE_REJECTED', 'check', {
        target: state.target,
        diagnostics: [diagnostic('HANDOFF_DELEGATE_REJECTED', '$.children', 'Expected one to sixteen session identifiers')],
      })
    }
    for (const child of children) state.sessions.add(child)
    return { ok: true, action: 'delegate', outcome: 'delegated', code: null, nextAction: 'execute', handoffId, lease: state.lease, childSessionIds: children, diagnostics: [] }
  }

  async function reviewAllowed(sessionId) {
    const state = typeof sessionId === 'string' ? currentStateForSession(sessionId) : null
    if (!state) return { allowed: true, code: null, nextAction: 'check' }
    if (state.lease && (state.status === 'leased' || state.status === 'bound')) {
      return { allowed: false, code: 'HANDOFF_ACTIVE_EXECUTE', nextAction: 'status' }
    }
    return { allowed: true, code: null, nextAction: state.required === true ? 'review' : 'check' }
  }

  function guard(exec) {
    if (closed) return undefined
    const sessionId = sessionIdOf(exec)
    if (sessionId === null) return undefined
    const name = typeof exec?.name === 'string' ? exec.name : ''
    const args = isPlainObject(exec?.arguments) ? exec.arguments : {}
    const state = currentStateForSession(sessionId)
    if (!state) {
      // A fresh or resumed execute session has no lease until it asks for one.
      // Direct skill loads, mode switches and manual worker starts therefore
      // cannot gain product writes without an explicit ulw_handoff check.
      const unboundCwd = exec?.agent?.session?.header?.cwd
      if (FILE_TOOLS.has(name) && typeof unboundCwd === 'string' && isUnderPlanOrDraft(unboundCwd, args.file_path)) return undefined
      if (SAFE_TOOLS.has(name)) return undefined
      return REFUSAL + ' (HANDOFF_LEASE_MISSING, nextAction=check): no verified handoff lease exists for this execute session. ' +
        'Call ulw_handoff check for the selected plan, run the plan review when required, then call ulw_handoff bind-worktree for a task worktree. ' + EXIT
    }
    const cwd = exec?.agent?.session?.header?.cwd ?? state.workspace
    if (FILE_TOOLS.has(name) && isUnderPlanOrDraft(cwd, args.file_path)) return undefined
    if (SAFE_TOOLS.has(name)) return undefined
    if (state.status === 'revoked' || state.status === 'cancelled') {
      return denialText(state, 'HANDOFF_LEASE_REVOKED', 'check')
    }
    if (!state.lease) {
      const code = state.status === 'bootstrap' ? 'HANDOFF_REVIEW_REQUIRED' : 'HANDOFF_LEASE_MISSING'
      return denialText(state, code, state.required === true ? 'review' : 'check')
    }
    if (state.lease.required === true) {
      const nowValue = now === null ? null : now()
      if (Number.isSafeInteger(nowValue) && Number.isSafeInteger(state.lease.expiresAt) && nowValue >= state.lease.expiresAt) {
        revokeState(state, 'expired', nowValue)
        return denialText(state, 'HANDOFF_LEASE_EXPIRED', 'check')
      }
      const current = readSourceSync(cwd, state.target)
      if (current === null || current.instructionSha256 !== state.lease.instructionSha256) {
        revokeState(state, 'instruction_changed', nowValue)
        return denialText(state, 'HANDOFF_STALE_SOURCE', 'review')
      }
    }
    return undefined
  }

  function stateForSession(sessionId) {
    const state = typeof sessionId === 'string' ? currentStateForSession(sessionId) : null
    if (!state) return null
    return clone({
      handoffId: state.handoffId,
      workspace: state.workspace,
      target: state.target,
      required: state.required,
      status: state.status,
      approvalToken: state.approvalToken,
      approvalState: state.approvalState,
      lease: state.lease,
      binding: state.binding,
      receipt: state.receipt,
      revokedAt: state.revokedAt,
      revokedReason: state.revokedReason,
    })
  }
  function stateOf(handoffId) {
    const state = typeof handoffId === 'string' ? states.get(handoffId) : undefined
    if (!state) return null
    return clone({
      handoffId: state.handoffId,
      target: state.target,
      required: state.required,
      status: state.status,
      approvalToken: state.approvalToken,
      lease: state.lease,
      binding: state.binding,
      receipt: state.receipt,
      sessions: [...state.sessions],
      revokedAt: state.revokedAt,
      revokedReason: state.revokedReason,
    })
  }
  function close() {
    closed = true
  }

  return Object.freeze({
    workspace,
    check,
    bootstrap,
    bindWorktree,
    assertLease,
    revoke,
    delegate,
    reviewAllowed,
    guard,
    stateForSession,
    stateOf,
    close,
  })
}
