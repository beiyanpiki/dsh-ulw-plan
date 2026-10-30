/**
 * The reviewer execution policy: one global monotonic tool guard plus the
 * per-lane state it keys on.
 *
 * The guard NEVER grants a capability. It only refuses, and it decides from
 * Host-owned identity (the pre-bound child session id and the preset the Host
 * says the agent ACTUALLY runs), never from model text, tool arguments or plan
 * prose. `reviewerToolRestriction()` exists as defense-in-depth hiding of
 * inherited tools, but a restriction is not the authority: it cannot hide a
 * child's own-layer structured-output tool, a same-name local registration or a
 * future tool, so the guard refuses every name outside the current phase
 * allowlist:
 *
 *   awaiting_input -> ulw_review_input
 *   input_complete -> ulw_review_input, read, glob, grep, structured_output
 *   settled        -> nothing
 *
 * Out of scope by contract: the guard does not inspect plan bytes, does not
 * classify prompt injection, does not bypass or replace Host fs policy (an
 * allowed `read` still passes through it), never calls a model, and cannot
 * approve a review. An incomplete input can only settle as INCONCLUSIVE; it can
 * never approve. Delegated children run under the native `never` approval
 * policy, so no reviewer refusal is an interactive escalation prompt.
 *
 * @module dsh-ulw-plan/review-policy
 */
import { REVIEW_LANES } from './review-protocol.js'
import { REVIEW_LANE_PRESETS, isReviewPreset } from './review-presets.js'

/** The one tool that delivers bound plan pages and advances coverage. */
export const REVIEW_INPUT_TOOL = 'ulw_review_input'
/** The native structured-output capture tool registered in the child's own layer. */
export const REVIEW_CAPTURE_TOOL = 'structured_output'
/** Read-only evidence tools unlocked only after complete plan delivery. */
export const REVIEW_READ_TOOLS = Object.freeze(['read', 'glob', 'grep'])
/** Delegated children are pinned to this native approval policy; nothing escalates. */
export const REVIEW_APPROVAL_POLICY = 'never'
/** Stable prefix for every refusal this guard returns. */
export const REVIEW_DENIAL_PREFIX = 'ulw-review policy'
/** The terminal verdict vocabulary accepted by the result contract. */
export const REVIEW_TERMINAL_VERDICTS = Object.freeze(['OKAY', 'REJECT', 'INCONCLUSIVE'])
/** The three monotonic phases of one reviewer binding. */
export const REVIEW_STAGES = Object.freeze({
  awaitingInput: 'awaiting_input',
  inputComplete: 'input_complete',
  settled: 'settled',
})

/** A policy seam or coverage failure owned by this module. */
export class ReviewPolicyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReviewPolicyError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new ReviewPolicyError(code, message)
}

const denial = (code, detail) =>
  REVIEW_DENIAL_PREFIX +
  ': ' +
  code +
  ': ' +
  detail +
  '. No tool body runs; the reviewer approval policy is ' +
  REVIEW_APPROVAL_POLICY +
  ' and no interactive escalation exists.'

/**
 * Map one reviewer's input coverage and captured verdict to its lane outcome.
 * Incomplete delivery can only end INCONCLUSIVE, so an early "OKAY" can never
 * become an approval.
 * @param inputComplete - whether the bound plan was delivered in full.
 * @param verdict - the captured verdict, if any.
 * @returns `OKAY`, `REJECT` or `INCONCLUSIVE`.
 */
export function resolveReviewerOutcome(inputComplete, verdict) {
  if (inputComplete !== true) return 'INCONCLUSIVE'
  return REVIEW_TERMINAL_VERDICTS.includes(verdict) ? verdict : 'INCONCLUSIVE'
}

/**
 * The inherited-tool mask a reviewer child may apply. This is NOT the security
 * boundary: restrictions ignore the child's own layer (where `structured_output`
 * lives) and cannot anticipate a future tool, which is exactly why the
 * monotonic guard below refuses unknown names by default.
 * @returns an allow filter over the caller's inherited global tools.
 */
export function reviewerToolRestriction() {
  return Object.freeze({ allow: Object.freeze([REVIEW_INPUT_TOOL, ...REVIEW_READ_TOOLS].sort()) })
}

function sessionIdOf(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function probe(seam, agent) {
  if (typeof seam !== 'function') return undefined
  try {
    const value = seam(agent)
    return typeof value === 'string' ? value : undefined
  } catch {
    // An unavailable resolver is "unknown", never a licence to pass.
    return undefined
  }
}

/** Read a self-claimed reviewer preset from ordinary Agent/session metadata. */
function claimedPresetOf(agent) {
  const header = agent?.session?.header
  const candidates = [
    agent?.agentPreset,
    agent?.preset,
    header?.agentPreset,
    header?.preset,
    header?.selectedPreset,
  ]
  return candidates.find((value) => isReviewPreset(value))
}

function summaryOf(binding) {
  return Object.freeze({
    childId: binding.childId,
    lane: binding.lane,
    preset: binding.preset,
    stage: binding.stage,
    deliveredBytes: binding.deliveredBytes,
    totalBytes: binding.totalBytes,
    settled: binding.settled,
    verdict: binding.verdict,
    outcome: binding.outcome,
  })
}

/**
 * Create the reviewer state machine and its synchronous guard.
 * @param options - optional `actualPreset(agent)` and `claimedPreset(agent)` seams.
 * @returns the policy surface used by the Host adapter and tests.
 */
export function createReviewPolicy(options = {}) {
  const actualPreset = options.actualPreset
  const claimedPreset = typeof options.claimedPreset === 'function' ? options.claimedPreset : claimedPresetOf
  const bindings = new Map()
  let closing = false

  function settleInternal(binding, verdict) {
    if (binding.settled) return summaryOf(binding)
    binding.verdict = verdict
    binding.outcome = resolveReviewerOutcome(binding.stage === REVIEW_STAGES.inputComplete, verdict)
    binding.stage = REVIEW_STAGES.settled
    binding.settled = true
    binding.resolveSettled()
    return summaryOf(binding)
  }

  /**
   * Bind one pre-allocated child identity to a lane before it starts.
   * @param input - `{ childId, lane, preset, settled? }`; preset must be the
   *   exact registration of that lane.
   * @returns a detached summary of the new binding.
   */
  function bindReviewer(input) {
    if (closing) {
      fail('REVIEW_CLOSED', 'Reviewer admission is closed while the guard is being disposed after settle')
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      fail('REVIEW_INVALID_BINDING', 'Expected a reviewer binding object')
    }
    const { childId, lane, preset, settled } = input
    if (
      typeof childId !== 'string' ||
      childId.length === 0 ||
      childId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(childId)
    ) {
      fail('REVIEW_INVALID_BINDING', 'Expected one nonempty pre-bound child session id')
    }
    if (!REVIEW_LANES.includes(lane)) fail('REVIEW_INVALID_BINDING', 'Unknown review lane: ' + String(lane))
    if (preset !== REVIEW_LANE_PRESETS[lane]) {
      fail(
        'REVIEW_INVALID_BINDING',
        'The binding must name the actual registered preset of its lane (' + REVIEW_LANE_PRESETS[lane] + ')',
      )
    }
    if (bindings.has(childId)) {
      fail('REVIEW_ALREADY_BOUND', 'Reviewer child ' + childId + ' is already bound; a new round needs a new pre-bound child id')
    }
    if (settled !== undefined && (settled === null || typeof settled.then !== 'function')) {
      fail('REVIEW_INVALID_BINDING', 'The optional settled seam must be a thenable')
    }
    let resolveSettled
    const settlePromise = new Promise((resolve) => {
      resolveSettled = resolve
    })
    const binding = {
      childId,
      lane,
      preset,
      stage: REVIEW_STAGES.awaitingInput,
      deliveredBytes: 0,
      totalBytes: undefined,
      settled: false,
      verdict: undefined,
      outcome: undefined,
      settlePromise,
      resolveSettled,
    }
    bindings.set(childId, binding)
    if (settled !== undefined) {
      settled.then(
        () => settleInternal(binding, undefined),
        () => settleInternal(binding, undefined),
      )
    }
    return summaryOf(binding)
  }

  /**
   * Record one monotonic coverage advance for a bound reviewer.
   * @param childId - the pre-bound child session id.
   * @param coverage - `{ deliveredBytes, totalBytes }` for the whole plan.
   * @returns a detached summary of the binding.
   */
  function recordDelivery(childId, coverage) {
    const binding = bindings.get(childId)
    if (binding === undefined) fail('REVIEW_UNKNOWN_REVIEWER', 'No reviewer binding for ' + String(childId))
    if (binding.settled) fail('REVIEW_STALE_REVIEWER', 'Reviewer ' + childId + ' has settled; late delivery is stale')
    if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) {
      fail('REVIEW_INVALID_COVERAGE', 'Expected a coverage object { deliveredBytes, totalBytes }')
    }
    const { deliveredBytes, totalBytes } = coverage
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      fail('REVIEW_INVALID_COVERAGE', 'totalBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(deliveredBytes) || deliveredBytes < 0 || deliveredBytes > totalBytes) {
      fail('REVIEW_INVALID_COVERAGE', 'deliveredBytes must be a safe integer within [0, totalBytes]')
    }
    if (binding.totalBytes !== undefined && binding.totalBytes !== totalBytes) {
      fail('REVIEW_COVERAGE_MISMATCH', 'Coverage cannot switch to a different artifact size')
    }
    if (binding.deliveredBytes > deliveredBytes) {
      fail('REVIEW_COVERAGE_REGRESSION', 'Coverage is monotonic; it cannot move backwards')
    }
    binding.totalBytes = totalBytes
    binding.deliveredBytes = deliveredBytes
    if (deliveredBytes === totalBytes) binding.stage = REVIEW_STAGES.inputComplete
    return summaryOf(binding)
  }

  /**
   * Settle one reviewer after its activation resolves (or is cancelled).
   * Idempotent: the first terminal call wins, later calls are no-ops.
   * @param childId - the pre-bound child session id.
   * @param options - optional `{ verdict }`.
   * @returns a detached summary, or undefined for an unknown id (cleanup-safe).
   */
  function settleReviewer(childId, options = {}) {
    const binding = bindings.get(childId)
    if (binding === undefined) return undefined
    const verdict = options?.verdict
    if (verdict !== undefined && !REVIEW_TERMINAL_VERDICTS.includes(verdict)) {
      fail('REVIEW_INVALID_VERDICT', 'Unknown reviewer verdict: ' + String(verdict))
    }
    return settleInternal(binding, verdict)
  }

  /** Whether a bound reviewer's full plan input has been delivered. */
  function isInputComplete(childId) {
    return bindings.get(childId)?.stage === REVIEW_STAGES.inputComplete
  }

  /** This lane's phase, or undefined for an unknown id. */
  function stageOf(childId) {
    return bindings.get(childId)?.stage
  }

  /** Whether this reviewer already reached a terminal state. */
  function isSettled(childId) {
    return bindings.get(childId)?.settled === true
  }

  /** The lane outcome recorded at settle, or undefined. */
  function outcomeOf(childId) {
    return bindings.get(childId)?.outcome
  }

  /**
   * Coverage eligibility of one lane. This is an input prerequisite, NEVER an
   * approval: only the coordinator may merge two complete, terminal receipts.
   */
  function approvalEligible(childId) {
    const binding = bindings.get(childId)
    return binding !== undefined && binding.totalBytes !== undefined && binding.deliveredBytes === binding.totalBytes
  }

  /** Detached state snapshot for diagnostics and evidence. */
  function state() {
    const snapshot = {}
    for (const [childId, binding] of bindings) snapshot[childId] = summaryOf(binding)
    return Object.freeze(snapshot)
  }

  /**
   * The monotonic guard. Synchronous by contract: it never awaits a reviewer,
   * so a hung activation cannot block the Host's tool pipeline.
   * @param exec - the Host tool execution identity.
   * @returns a refusal string, or undefined to leave the call to other guards.
   */
  function guard(exec) {
    if (exec === null || typeof exec !== 'object') return undefined
    const agent = exec.agent
    if (agent === undefined || agent === null) return undefined
    const name = typeof exec.name === 'string' ? exec.name : ''
    const sessionId = sessionIdOf(agent)
    const actual = probe(actualPreset, agent)

    if (sessionId !== undefined) {
      const binding = bindings.get(sessionId)
      if (binding !== undefined) {
        if (binding.settled) {
          return denial('REVIEW_SETTLED', 'reviewer ' + sessionId + ' has settled and accepts no further tool calls')
        }
        if (actual !== binding.preset) {
          return denial(
            'REVIEW_IDENTITY_MISMATCH',
            'agent ' +
              sessionId +
              ' is bound to ' +
              binding.preset +
              ' but the Host resolves its actual preset as ' +
              (actual === undefined ? 'unknown' : JSON.stringify(actual)),
          )
        }
        if (binding.stage === REVIEW_STAGES.inputComplete) {
          if (name === REVIEW_INPUT_TOOL || name === REVIEW_CAPTURE_TOOL || REVIEW_READ_TOOLS.includes(name)) {
            return undefined
          }
          return denial(
            'REVIEW_TOOL_DENIED',
            'tool ' +
              JSON.stringify(name) +
              ' is outside the completed-input reviewer surface (' +
              [REVIEW_INPUT_TOOL, ...REVIEW_READ_TOOLS, REVIEW_CAPTURE_TOOL].join(', ') +
              ')',
          )
        }
        if (name === REVIEW_INPUT_TOOL) return undefined
        return denial(
          'REVIEW_TOOL_DENIED',
          'tool ' +
            JSON.stringify(name) +
            ' is refused before the bound plan input is complete; only ' +
            REVIEW_INPUT_TOOL +
            ' is allowed',
        )
      }
    }

    const claimed = probe(claimedPreset, agent)
    if (isReviewPreset(actual) || isReviewPreset(claimed)) {
      return denial(
        'REVIEW_UNBOUND_PRESET',
        'agent ' +
          (sessionId ?? '(no session id)') +
          ' runs/claims reviewer preset ' +
          JSON.stringify(isReviewPreset(actual) ? actual : claimed) +
          ' without a pre-bound child assignment',
      )
    }
    return undefined
  }

  /** Resolve once every currently bound reviewer has settled (admission is then closed). */
  async function waitForSettles() {
    for (;;) {
      const pending = []
      for (const binding of bindings.values()) if (!binding.settled) pending.push(binding.settlePromise)
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  /** Stop accepting new reviewer bindings; only disposal uses this. */
  function closeAdmission() {
    closing = true
  }

  return Object.freeze({
    bindReviewer,
    recordDelivery,
    settleReviewer,
    stageOf,
    isInputComplete,
    isSettled,
    outcomeOf,
    approvalEligible,
    state,
    guard,
    waitForSettles,
    closeAdmission,
  })
}

/**
 * Install the guard globally on the Host tool runtime and own its disposal.
 * Disposal is ordered AFTER every bound reviewer settles, so an unload can never
 * briefly remove the guard while a reviewer is still able to call tools.
 * @param options - `tools` (required), plus the createReviewPolicy seams.
 * @returns the policy surface plus an idempotent `dispose()` promise.
 */
export function installReviewPolicy(options = {}) {
  const tools = options.tools
  if (tools === null || typeof tools !== 'object' || typeof tools.guard !== 'function') {
    fail('REVIEW_TOOLS_UNAVAILABLE', 'installReviewPolicy needs the Host tools service (tools.guard)')
  }
  const policy = createReviewPolicy(options)
  const removeGuard = tools.guard((exec) => policy.guard(exec))
  if (typeof removeGuard !== 'function') {
    fail('REVIEW_GUARD_DISPOSER_MISSING', 'tools.guard did not return a disposer')
  }
  let disposal
  function dispose() {
    if (disposal !== undefined) return disposal
    disposal = (async () => {
      policy.closeAdmission()
      try {
        await policy.waitForSettles()
      } finally {
        removeGuard()
      }
    })()
    return disposal
  }
  return Object.freeze({ ...policy, dispose })
}
