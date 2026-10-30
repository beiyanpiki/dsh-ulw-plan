/** Host adapter for the native managed dual review lanes.
 *
 * Two fixed user-authorized routes are preflighted through the public LLM
 * service before a single request-level budget reservation is made. Both
 * `startActivation` calls are then invoked together under pre-bound child
 * identities, caller delivery, independent namespaced presets, supported
 * structured output, and context-free agent options. The returned handle
 * exposes the actual activation child identity, result promise and disposal;
 * native `subagent/start` / `subagent/end` payloads may only be paired by
 * runId for observation and can never authorize a verdict.
 *
 * Entry cancellation aborts only starts that were not accepted yet. After
 * acceptance, ownership passes to the caller (the coordinator), so the entry
 * signal no longer reaches the activation. A partial start observes every
 * promise, disposes accepted partners, and records which calls stay consumed.
 */
import { REVIEW_DIAGNOSTIC_CODES, REVIEW_LANES, REVIEW_RESULT_SCHEMA } from './review-protocol.js'
import { normalizeModelId } from './review-config.js'

export const REVIEW_TRANSPORT_PROVIDER = 'spawn'
export const REVIEW_TRANSPORT_PRESETS = Object.freeze({
  practical: 'ulw-plan-review-practical',
  adversarial: 'ulw-plan-review-adversarial',
})
/** Review diagnostic codes plus transport-only lifecycle outcomes. */
export const REVIEW_TRANSPORT_CODES = Object.freeze([...REVIEW_DIAGNOSTIC_CODES, 'CANCELLED', 'START_FAILED', 'DISPOSE_FAILED'])

const ROUTE_KEYS = Object.freeze(['provider', 'model', 'maxTokens', 'reasoningEffort'])
const REQUIRED_CAPABILITIES = Object.freeze(['agentOptions', 'agentPreset', 'outputSchema', 'depthLimit'])
const EFFORT = /^[a-z][a-z0-9_-]*$/

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSignal = value => typeof AbortSignal !== 'undefined' && value instanceof AbortSignal
const errorMessage = error => (error instanceof Error ? error.message : String(error))
const errorCode = (error, fallback) => (error && typeof error.code === 'string' && REVIEW_TRANSPORT_CODES.includes(error.code) ? error.code : fallback)
const zeroBudget = () => ({ reserved: 0, released: 0, consumed: 0 })
const fail = (code, message, details) => { throw new ReviewTransportError(code, message, details) }

/** One observable transport failure; details are plain snapshots for the coordinator. */
export class ReviewTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ReviewTransportError'
    this.code = code
    this.phase = details.phase ?? 'validate'
    this.lanes = [...(details.lanes ?? [])]
    this.budget = { ...zeroBudget(), ...(details.budget ?? {}) }
    const cleanup = details.cleanup ?? {}
    this.cleanup = {
      disposed: [...(cleanup.disposed ?? [])],
      disposeAttempts: [...(cleanup.disposeAttempts ?? [])],
      disposeErrors: [...(cleanup.disposeErrors ?? [])],
      observerReleased: cleanup.observerReleased === true,
    }
    this.cancelled = details.cancelled === true
    if (details.cause !== undefined) this.cause = details.cause
  }
}

function assertConfig(config) {
  if (!isObject(config)) fail('INVALID_CONFIG', 'Review transport requires the parsed review config object')
  if (config.enabled !== true) fail('ROUTE_UNAUTHORIZED', 'Review transport requires an enabled review config')
  if (config.backend !== REVIEW_TRANSPORT_PROVIDER) fail('CAPABILITY_UNAVAILABLE', 'Only the spawn review backend is supported')
  if (!isObject(config.lanes)) fail('ROUTE_UNAUTHORIZED', 'Both review lanes require an authorized route')
  for (const lane of REVIEW_LANES) {
    const route = config.lanes[lane]
    if (!isObject(route)) fail('ROUTE_UNAUTHORIZED', 'Missing ' + lane + ' review route')
    for (const key of Object.keys(route)) if (!ROUTE_KEYS.includes(key)) fail('ROUTE_UNAUTHORIZED', 'Unknown ' + lane + ' route field: ' + key)
    if (typeof route.provider !== 'string' || route.provider.length === 0) fail('ROUTE_UNAUTHORIZED', 'Missing ' + lane + ' provider')
    if (typeof route.model !== 'string' || route.model.length === 0) fail('ROUTE_UNAUTHORIZED', 'Missing ' + lane + ' model')
    if (!Number.isSafeInteger(route.maxTokens) || route.maxTokens <= 0) fail('ROUTE_UNAUTHORIZED', 'Missing ' + lane + ' maxTokens')
    if (Object.hasOwn(route, 'reasoningEffort') && (typeof route.reasoningEffort !== 'string' || !EFFORT.test(route.reasoningEffort))) {
      fail('ROUTE_UNAUTHORIZED', 'Invalid ' + lane + ' reasoningEffort')
    }
  }
}
function assertServices(subagents, llm) {
  if (!subagents || typeof subagents !== 'object' || typeof subagents.getProvider !== 'function' || typeof subagents.startActivation !== 'function') {
    fail('CAPABILITY_UNAVAILABLE', 'Native subagent activation service is unavailable')
  }
  if (!llm || typeof llm !== 'object' || typeof llm.resolveCallConfig !== 'function') {
    fail('CAPABILITY_UNAVAILABLE', 'LLM route preflight service is unavailable')
  }
}
function readProvider(subagents) {
  let provider
  try { provider = subagents.getProvider(REVIEW_TRANSPORT_PROVIDER) } catch (error) {
    fail('CAPABILITY_UNAVAILABLE', 'The spawn subagent provider could not be resolved', { cause: error })
  }
  if (!isObject(provider)) fail('CAPABILITY_UNAVAILABLE', 'The spawn subagent provider is not registered')
  if (provider.name !== REVIEW_TRANSPORT_PROVIDER) fail('CAPABILITY_UNAVAILABLE', 'The spawn provider is registered under an unexpected name')
  if (!isObject(provider.capabilities)) fail('CAPABILITY_UNAVAILABLE', 'The spawn provider exposes no capability descriptor')
  for (const capability of REQUIRED_CAPABILITIES) {
    if (provider.capabilities[capability] !== true) fail('CAPABILITY_UNAVAILABLE', 'The spawn provider lacks the ' + capability + ' capability')
  }
  if (provider.inheritsParentContext !== false) fail('CAPABILITY_UNAVAILABLE', 'The spawn provider must inherit no parent context')
  if (typeof provider.prepareContinuable !== 'function') fail('CAPABILITY_UNAVAILABLE', 'The spawn provider cannot honor a pre-bound child identity')
  return provider
}
function assertParent(parent) {
  if (!isObject(parent)) fail('INVALID_REQUEST', 'Review transport requires the exact parent agent')
}
function assertPrompts(prompts) {
  if (!isObject(prompts)) fail('INVALID_REQUEST', 'Review transport requires one prompt per lane')
  for (const lane of REVIEW_LANES) {
    const blocks = prompts[lane]
    if (!Array.isArray(blocks) || blocks.length === 0) fail('INVALID_REQUEST', 'Missing ' + lane + ' review prompt blocks')
    for (const block of blocks) {
      if (!isObject(block) || typeof block.type !== 'string' || block.type.length === 0) fail('INVALID_REQUEST', 'Invalid ' + lane + ' review prompt block')
    }
  }
}
function assertChildIds(childIds) {
  if (!isObject(childIds)) fail('INVALID_REQUEST', 'Review transport requires a pre-bound child identity per lane')
  const seen = new Set()
  for (const lane of REVIEW_LANES) {
    const childId = childIds[lane]
    if (typeof childId !== 'string' || childId.length === 0 || /[\u0000-\u001f\u007f]/.test(childId)) fail('INVALID_REQUEST', 'Missing ' + lane + ' child identity')
    if (seen.has(childId)) fail('INVALID_REQUEST', 'Review lanes must use distinct pre-bound child identities')
    seen.add(childId)
  }
}
function assertSignal(signal) {
  if (!isSignal(signal)) fail('INVALID_REQUEST', 'Review transport requires the caller AbortSignal')
}
function assertBudget(budget) {
  if (!budget || typeof budget !== 'object' || typeof budget.reserve !== 'function') {
    fail('CAPABILITY_UNAVAILABLE', 'An explicit call-budget reservation is required before native starts')
  }
}
function assertEvents(events) {
  if (events === undefined) return
  if (!isObject(events) || typeof events.onStart !== 'function' || typeof events.onEnd !== 'function') {
    fail('INVALID_REQUEST', 'Lifecycle observation requires onStart and onEnd subscriptions')
  }
}

function routeRequest(route) {
  const request = { provider: route.provider, model: route.model, maxTokens: route.maxTokens }
  if (Object.hasOwn(route, 'reasoningEffort')) request.reasoningEffort = route.reasoningEffort
  return request
}
function normalizeResolvedRoute(lane, requested, resolved) {
  const details = { phase: 'preflight' }
  if (!isObject(resolved)) fail('INVALID_RESULT', 'LLM preflight returned no route for the ' + lane + ' lane', details)
  if (resolved.provider !== requested.provider || resolved.model !== requested.model) fail('ROUTE_UNAUTHORIZED', 'LLM preflight changed the fixed ' + lane + ' route', details)
  if (!Number.isSafeInteger(resolved.maxTokens) || resolved.maxTokens <= 0) fail('ROUTE_UNAUTHORIZED', 'LLM preflight returned no usable maxTokens for the ' + lane + ' lane', details)
  let reasoningEffort
  if (Object.hasOwn(resolved, 'reasoningEffort')) {
    if (typeof resolved.reasoningEffort !== 'string' || !EFFORT.test(resolved.reasoningEffort)) fail('ROUTE_UNAUTHORIZED', 'LLM preflight returned an invalid reasoning effort for the ' + lane + ' lane', details)
    reasoningEffort = resolved.reasoningEffort
  }
  if (Object.hasOwn(requested, 'reasoningEffort') && reasoningEffort !== requested.reasoningEffort) fail('ROUTE_UNAUTHORIZED', 'LLM preflight did not preserve the ' + lane + ' reasoning effort', details)
  const route = { provider: resolved.provider, model: resolved.model, maxTokens: resolved.maxTokens }
  if (reasoningEffort !== undefined) route.reasoningEffort = reasoningEffort
  return Object.freeze(route)
}
function assertDistinctRoutes(routes) {
  let practical, adversarial
  try {
    practical = normalizeModelId(routes.practical.model)
    adversarial = normalizeModelId(routes.adversarial.model)
  } catch (error) {
    fail('ROUTE_UNAUTHORIZED', 'Resolved review routes are not canonical model identifiers', { phase: 'preflight', cause: error })
  }
  if (practical === adversarial) fail('ROUTE_UNAUTHORIZED', 'Both review lanes resolved to the same model identity', { phase: 'preflight' })
}

/** Validate and preflight both fixed routes. Metadata only: no activation, no budget, no content. */
export async function preflightReviewRoutes({ llm, config, signal } = {}) {
  if (!llm || typeof llm !== 'object' || typeof llm.resolveCallConfig !== 'function') fail('CAPABILITY_UNAVAILABLE', 'LLM route preflight service is unavailable')
  assertConfig(config)
  if (signal !== undefined && !isSignal(signal)) fail('INVALID_REQUEST', 'Route preflight signal must be an AbortSignal')
  if (signal?.aborted) fail('CANCELLED', 'Route preflight was cancelled', { phase: 'preflight', cancelled: true })
  const pending = REVIEW_LANES.map(lane => {
    const requested = config.lanes[lane]
    let call
    try { call = llm.resolveCallConfig(routeRequest(requested), signal) } catch (error) { call = Promise.reject(error) }
    return Promise.resolve(call).then(resolved => normalizeResolvedRoute(lane, requested, resolved))
  })
  const settled = await Promise.allSettled(pending)
  const routes = {}
  const failures = []
  settled.forEach((entry, index) => {
    const lane = REVIEW_LANES[index]
    if (entry.status === 'fulfilled') { routes[lane] = entry.value; return }
    const cancelled = signal?.aborted === true
    failures.push({
      lane, phase: 'preflight', code: cancelled ? 'CANCELLED' : errorCode(entry.reason, 'ROUTE_UNAUTHORIZED'),
      message: errorMessage(entry.reason), accepted: false, consumed: false, cancelled,
    })
  })
  if (failures.length) {
    const cancelled = failures.every(failure => failure.code === 'CANCELLED')
    fail(cancelled ? 'CANCELLED' : failures[0].code,
      'Review route preflight failed: ' + failures.map(failure => failure.lane + ': ' + failure.message).join('; '),
      { phase: 'preflight', lanes: failures, cancelled })
  }
  assertDistinctRoutes(routes)
  return routes
}

/** Pair the native observe-only lifecycle events by runId. No method yields a verdict. */
export function createRunPairing(childIds) {
  const lanes = REVIEW_LANES.map(lane => ({
    lane,
    childId: isObject(childIds) ? childIds[lane] : undefined,
    runId: undefined,
    provider: undefined,
    local: undefined,
    started: false,
    ended: false,
    stopReason: undefined,
  }))
  const unmatchedStarts = []
  const unmatchedEnds = []
  const conflicts = []
  const validStart = info => isObject(info) && typeof info.runId === 'string' && info.runId.length > 0 && typeof info.id === 'string' && info.id.length > 0
  function start(info) {
    if (!validStart(info)) { unmatchedStarts.push({ malformed: true }); return undefined }
    const lane = lanes.find(candidate => candidate.childId === info.id)
    if (!lane) { unmatchedStarts.push({ runId: info.runId, id: info.id, provider: typeof info.provider === 'string' ? info.provider : undefined }); return undefined }
    if (lane.started) { conflicts.push({ kind: 'start', reason: 'duplicate-start', lane: lane.lane }); return undefined }
    lane.started = true
    lane.runId = info.runId
    lane.provider = typeof info.provider === 'string' ? info.provider : undefined
    lane.local = info.local === true
    return lane.lane
  }
  function end(info) {
    if (!validStart(info)) { unmatchedEnds.push({ malformed: true }); return undefined }
    const lane = lanes.find(candidate => candidate.started && candidate.runId === info.runId)
    if (!lane) { unmatchedEnds.push({ runId: info.runId, id: info.id }); return undefined }
    if (lane.ended) { conflicts.push({ kind: 'end', reason: 'duplicate-end', lane: lane.lane }); return undefined }
    if (info.id !== lane.childId || info.provider !== lane.provider) { conflicts.push({ kind: 'end', reason: 'identity-mismatch', lane: lane.lane }); return undefined }
    lane.ended = true
    lane.stopReason = typeof info.stopReason === 'string' ? info.stopReason : 'unknown'
    return lane.lane
  }
  function snapshot() {
    return {
      lanes: lanes.map(lane => ({ ...lane })),
      unmatchedStarts: unmatchedStarts.map(entry => ({ ...entry })),
      unmatchedEnds: unmatchedEnds.map(entry => ({ ...entry })),
      conflicts: conflicts.map(entry => ({ ...entry })),
    }
  }
  return { start, end, snapshot }
}

function activationProblem(lane, activation) {
  if (!isObject(activation)) return 'Start resolved without an activation handle'
  if (typeof activation.childId !== 'string' || activation.childId.length === 0) return 'Activation returned no child identity'
  if (activation.childId !== lane.expectedChildId) return 'Activation identity does not match the pre-bound assignment'
  if (!activation.result || typeof activation.result.then !== 'function') return 'Activation returned no result promise'
  if (typeof activation.dispose !== 'function') return 'Activation returned no dispose()'
  if (typeof activation.messageId !== 'string' || activation.messageId.length === 0) return 'Local activation returned no accepted message identity'
  return undefined
}
function disposeActivation(lane) {
  if (!lane.disposePromise) {
    lane.disposeAttempted = true
    lane.disposePromise = Promise.resolve().then(() => {
      if (!lane.activation || typeof lane.activation.dispose !== 'function') {
        fail('DISPOSE_FAILED', 'The ' + lane.lane + ' activation exposes no dispose()', { phase: 'dispose', lanes: [{ lane: lane.lane, childId: lane.childId, disposed: false }] })
      }
      return lane.activation.dispose()
    }).then(
      () => { lane.disposed = true },
      error => { lane.disposed = false; lane.disposeError = errorMessage(error); throw error },
    )
    lane.disposePromise.catch(() => {})
  }
  return lane.disposePromise
}

/** Preflight both routes, reserve two requests once, then start both activations together. */
export async function startReviewActivations(options) {
  if (!isObject(options)) fail('INVALID_REQUEST', 'Review transport options must be an object')
  const { subagents, llm, config, parent, prompts, childIds, signal, budget, events } = options
  assertServices(subagents, llm)
  readProvider(subagents)
  assertConfig(config)
  assertParent(parent)
  assertPrompts(prompts)
  assertChildIds(childIds)
  assertSignal(signal)
  assertBudget(budget)
  assertEvents(events)
  if (signal.aborted) fail('CANCELLED', 'Review start was cancelled before route preflight', { phase: 'preflight', cancelled: true })

  const routes = await preflightReviewRoutes({ llm, config, signal })
  if (signal.aborted) fail('CANCELLED', 'Review start was cancelled before budget reservation', { phase: 'budget', cancelled: true })

  const budgetState = zeroBudget()
  let reservation
  try { reservation = await budget.reserve(REVIEW_LANES.length) } catch (error) {
    fail(errorCode(error, 'BUDGET_EXHAUSTED'), 'Review call budget could not be reserved: ' + errorMessage(error), { phase: 'budget', budget: budgetState, cause: error })
  }
  if (!reservation || typeof reservation.release !== 'function') fail('CAPABILITY_UNAVAILABLE', 'The call-budget reservation returned no release handle', { phase: 'budget', budget: budgetState })
  budgetState.reserved = REVIEW_LANES.length
  budgetState.consumed = REVIEW_LANES.length
  const budgetReleaseErrors = []
  const releaseCalls = count => {
    if (count <= 0) return
    try {
      reservation.release(count)
      budgetState.released += count
      budgetState.consumed -= count
    } catch (error) {
      budgetReleaseErrors.push(errorMessage(error))
    }
  }
  if (signal.aborted) {
    releaseCalls(REVIEW_LANES.length)
    fail('CANCELLED', 'Review start was cancelled while the budget was reserved', { phase: 'budget', budget: budgetState, cancelled: true })
  }

  const runs = createRunPairing(childIds)
  let releaseObservers = () => {}
  if (events) {
    const unsubs = []
    try {
      unsubs.push(events.onStart(info => { runs.start(info) }))
      unsubs.push(events.onEnd(info => { runs.end(info) }))
      if (unsubs.some(unsub => typeof unsub !== 'function')) throw new Error('Lifecycle subscription returned no unsubscribe function')
    } catch (error) {
      for (const unsub of unsubs) { try { if (typeof unsub === 'function') unsub() } catch { /* best effort */ } }
      releaseCalls(REVIEW_LANES.length)
      fail('CAPABILITY_UNAVAILABLE', 'Native lifecycle observation could not be registered: ' + errorMessage(error), { phase: 'validate', budget: budgetState, cause: error })
    }
    let active = true
    releaseObservers = () => {
      if (!active) return
      active = false
      const errors = []
      for (const unsub of unsubs) { try { unsub() } catch (error) { errors.push(errorMessage(error)) } }
      if (errors.length) fail('DISPOSE_FAILED', 'Lifecycle observer release failed: ' + errors.join('; '), { phase: 'dispose', budget: budgetState })
    }
  }
  if (signal.aborted) {
    try { releaseObservers() } catch { /* cancellation already owns the failure */ }
    releaseCalls(REVIEW_LANES.length)
    fail('CANCELLED', 'Review start was cancelled before activations were invoked', { phase: 'budget', budget: budgetState, cancelled: true })
  }

  const lanes = REVIEW_LANES.map(lane => ({
    lane,
    expectedChildId: childIds[lane],
    route: routes[lane],
    preset: REVIEW_TRANSPORT_PRESETS[lane],
    controller: new AbortController(),
    accepted: false,
    abortedBeforeAcceptance: false,
    activation: undefined,
    childId: undefined,
    messageId: undefined,
    consumed: false,
    released: false,
    disposeAttempted: false,
    disposed: false,
    disposeError: undefined,
    disposePromise: undefined,
  }))
  const onEntryAbort = () => {
    for (const lane of lanes) {
      if (lane.accepted) continue
      lane.abortedBeforeAcceptance = true
      try { lane.controller.abort(signal.reason) } catch { lane.controller.abort() }
    }
  }
  signal.addEventListener('abort', onEntryAbort, { once: true })
  if (signal.aborted) onEntryAbort()

  const startPromises = lanes.map(lane => {
    const spec = {
      provider: REVIEW_TRANSPORT_PROVIDER,
      label: lane.preset,
      childId: lane.expectedChildId,
      delivery: 'caller',
      signal: lane.controller.signal,
      request: {
        parent,
        prompt: prompts[lane.lane],
        agentPreset: lane.preset,
        agentOptions: lane.route,
        outputSchema: REVIEW_RESULT_SCHEMA,
      },
    }
    let pending
    try { pending = Promise.resolve(subagents.startActivation(spec)) } catch (error) { pending = Promise.reject(error) }
    pending.then(() => { lane.accepted = true }, () => {})
    return pending
  })
  const settled = await Promise.allSettled(startPromises)
  signal.removeEventListener('abort', onEntryAbort)

  const failures = []
  settled.forEach((entry, index) => {
    const lane = lanes[index]
    if (entry.status === 'rejected') {
      failures.push({
        lane: lane.lane, phase: 'start', code: lane.abortedBeforeAcceptance ? 'CANCELLED' : errorCode(entry.reason, 'START_FAILED'),
        message: errorMessage(entry.reason), accepted: false, consumed: false, cancelled: lane.abortedBeforeAcceptance,
      })
      return
    }
    const activation = entry.value
    lane.activation = activation
    if (isObject(activation) && typeof activation.childId === 'string') lane.childId = activation.childId
    if (isObject(activation) && activation.result !== undefined && activation.result !== null) {
      // Observe now: an exceptional result must not become an unhandled rejection
      // while cleanup or the caller still owns this activation.
      try { Promise.resolve(activation.result).catch(() => {}) } catch { /* non-awaitable result is rejected by activationProblem */ }
    }
    if (lane.abortedBeforeAcceptance) {
      lane.accepted = false
      failures.push({ lane: lane.lane, phase: 'signal', code: 'CANCELLED', message: 'Activation was cancelled before acceptance', accepted: false, consumed: false, cancelled: true })
      return
    }
    const problem = activationProblem(lane, activation)
    if (problem) {
      failures.push({ lane: lane.lane, phase: 'start', code: 'INVALID_RESULT', message: problem, accepted: true, consumed: true, cancelled: false })
      return
    }
    lane.messageId = activation.messageId
    lane.consumed = true
  })

  if (failures.length) {
    let releaseCount = 0
    for (const lane of lanes) {
      const failure = failures.find(item => item.lane === lane.lane)
      if (!failure) continue
      lane.consumed = failure.consumed
      if (failure.consumed === false && !lane.released) { lane.released = true; releaseCount += 1 }
    }
    if (releaseCount > 0) releaseCalls(releaseCount)
    const cleanup = { disposed: [], disposeAttempts: [], disposeErrors: [], observerReleased: false }
    const targets = lanes.filter(lane => lane.activation && typeof lane.activation.dispose === 'function')
    const disposals = await Promise.allSettled(targets.map(lane => disposeActivation(lane)))
    disposals.forEach((entry, index) => {
      const lane = targets[index]
      if (!cleanup.disposeAttempts.includes(lane.lane)) cleanup.disposeAttempts.push(lane.lane)
      if (entry.status === 'fulfilled') cleanup.disposed.push(lane.lane)
      else cleanup.disposeErrors.push({ lane: lane.lane, childId: lane.childId, message: errorMessage(entry.reason) })
    })
    for (const lane of lanes) {
      if (lane.activation && typeof lane.activation.dispose !== 'function') {
        lane.disposeError = 'Activation returned no dispose()'
        cleanup.disposeErrors.push({ lane: lane.lane, childId: lane.childId, message: lane.disposeError })
      }
    }
    try { releaseObservers(); cleanup.observerReleased = true } catch (error) {
      cleanup.observerReleased = true
      cleanup.disposeErrors.push({ lane: 'observers', message: errorMessage(error) })
    }
    if (budgetReleaseErrors.length) cleanup.disposeErrors.push({ lane: 'budget', message: budgetReleaseErrors.join('; ') })

    const outcomes = lanes.map(lane => {
      const base = {
        lane: lane.lane, expectedChildId: lane.expectedChildId, childId: lane.childId,
        accepted: lane.accepted === true, consumed: lane.consumed === true, disposed: lane.disposed === true,
      }
      const failure = failures.find(item => item.lane === lane.lane)
      if (failure) return { ...base, phase: failure.phase, code: failure.code, message: failure.message, ...(lane.disposeError ? { disposeError: lane.disposeError } : {}) }
      return { ...base, phase: 'cleanup', code: 'CLEANUP_ON_FAILURE', message: 'Accepted partner disposed because the other lane did not start' }
    })
    const cancelled = failures.every(failure => failure.code === 'CANCELLED') && signal.aborted === true
    let code = failures[0].code
    if (!cancelled && failures.some(failure => failure.code === 'INVALID_RESULT')) code = 'INVALID_RESULT'
    fail(code, 'Review activation start failed: ' + failures.map(failure => failure.lane + ': ' + failure.message).join('; '), {
      phase: cancelled ? 'start' : failures[0].phase,
      lanes: outcomes,
      budget: { ...budgetState },
      cleanup,
      cancelled,
    })
  }

  const laneHandles = lanes.map(lane => ({
    lane: lane.lane,
    childId: lane.childId,
    expectedChildId: lane.expectedChildId,
    messageId: lane.messageId,
    preset: lane.preset,
    route: lane.route,
    result: lane.activation.result,
    dispose: () => disposeActivation(lane),
  }))
  let disposePromise
  const dispose = () => {
    if (!disposePromise) {
      disposePromise = (async () => {
        const targets = lanes.filter(lane => lane.activation)
        const disposals = await Promise.allSettled(targets.map(lane => disposeActivation(lane)))
        const disposeErrors = []
        disposals.forEach((entry, index) => {
          if (entry.status === 'rejected') disposeErrors.push({ lane: targets[index].lane, childId: targets[index].childId, message: errorMessage(entry.reason) })
        })
        const outcomes = lanes.map(lane => ({
          lane: lane.lane,
          childId: lane.childId,
          disposed: lane.disposed === true,
          ...(lane.disposed === true ? {} : { disposeError: lane.disposeError ?? 'disposal did not settle' }),
        }))
        if (disposeErrors.length) {
          fail('DISPOSE_FAILED', 'Review activation disposal failed', {
            phase: 'dispose',
            lanes: outcomes,
            budget: { ...budgetState },
            cleanup: {
              disposed: lanes.filter(lane => lane.disposed === true).map(lane => lane.lane),
              disposeAttempts: lanes.filter(lane => lane.disposeAttempted === true).map(lane => lane.lane),
              disposeErrors,
              observerReleased: false,
            },
          })
        }
      })()
    }
    return disposePromise
  }

  return {
    provider: REVIEW_TRANSPORT_PROVIDER,
    lanes: laneHandles,
    budget: { ...budgetState },
    runs,
    releaseObservers,
    dispose,
  }
}
