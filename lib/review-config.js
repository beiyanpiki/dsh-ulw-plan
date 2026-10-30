/** Explicit user authorization only. Parsing never resolves routes or calls a model. */
import { REVIEW_LANES, ReviewContractError, assertPlainJson, assertReviewKeys } from './review-protocol.js'
const fail = (code, path, message) => { throw new ReviewContractError(code, path, message) }
const token = (value, path) => {
  if (typeof value !== 'string' || [...value].some(c => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) || /[/:]$/.test(value)) fail('ROUTE_UNAUTHORIZED', path, 'Expected explicit provider/model identifier')
  return value
}

/** Conservative identity comparison, not proof of opaque gateway model weights.
 * Provider namespaces, case, dotted version punctuation, family/version order,
 * dated snapshots and known rolling aliases cannot manufacture independence.
 * Different genuinely unknown gateway aliases remain unverifiable: operators
 * must configure distinct underlying models honestly.
 */
export function normalizeModelId(model) {
  token(model, '$.model')
  let value = model.toLowerCase().split('/').at(-1).replace(/:(?:free|nitro|floor|extended)$/, '')
  // A namespace before ':' is provider metadata, never a second model identity.
  value = value.split(':').at(-1)
  value = value.replace(/-(?:latest|[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$/, '')
  // '4.5' and '4-5' are the same version; dots never identify a different model.
  value = value.replace(/([0-9])\.(?=[0-9])/g, '$1-')
  // Both 'claude-<family>-<version>' and 'claude-<version>-<family>' are aliases.
  value = value.replace(/^claude-(sonnet|opus|haiku)-([0-9]+(?:-[0-9]+)?)$/, 'claude-$1-$2')
  value = value.replace(/^claude-([0-9]+(?:-[0-9]+)?)-(sonnet|opus|haiku)$/, 'claude-$2-$1')
  const aliases = new Map([['deepseek-chat', 'deepseek-v3'], ['deepseek-reasoner', 'deepseek-r1']])
  return aliases.get(value) ?? value
}

/** Pass rawConfig.review, not the plugin config envelope. Returned data is detached.
 * Disabled defaults contain no authorized routes and no calls. Explicit settings
 * are still validated when disabled, to reject latent malformed authorization.
 */
export function parseReviewConfig(raw = {}) {
  const code = 'INVALID_CONFIG'
  assertPlainJson(raw, code)
  assertReviewKeys(raw, ['enabled', 'storageBackend', 'backend', 'callBudget', 'lanes'], [], code)
  const enabled = Object.hasOwn(raw, 'enabled') ? raw.enabled : false
  if (typeof enabled !== 'boolean') fail(code, '$.enabled', 'Expected boolean')
  const storageBackend = Object.hasOwn(raw, 'storageBackend') ? raw.storageBackend : 'json'
  const backend = Object.hasOwn(raw, 'backend') ? raw.backend : 'spawn'
  if (storageBackend !== 'json' || backend !== 'spawn') fail('CAPABILITY_UNAVAILABLE', '$', 'Only json storage and spawn reviews are supported')
  let callBudget = 0
  if (Object.hasOwn(raw, 'callBudget')) {
    if (!Number.isSafeInteger(raw.callBudget) || raw.callBudget <= 0 || raw.callBudget % 2 !== 0) fail('BUDGET_EXHAUSTED', '$.callBudget', 'Explicit positive even callBudget required')
    callBudget = raw.callBudget
  } else if (enabled) fail('BUDGET_EXHAUSTED', '$.callBudget', 'No model calls authorized without explicit budget')
  const lanes = {}
  if (Object.hasOwn(raw, 'lanes')) {
    assertReviewKeys(raw.lanes, REVIEW_LANES, enabled ? REVIEW_LANES : [], 'ROUTE_UNAUTHORIZED', '$.lanes')
    for (const lane of REVIEW_LANES) {
      if (!Object.hasOwn(raw.lanes, lane)) continue
      const r = raw.lanes[lane], p = '$.lanes.' + lane
      assertReviewKeys(r, ['provider', 'model', 'maxTokens', 'reasoningEffort'], ['provider', 'model', 'maxTokens'], 'ROUTE_UNAUTHORIZED', p)
      const provider = token(r.provider, p + '.provider'), model = token(r.model, p + '.model')
      if (!Number.isSafeInteger(r.maxTokens) || r.maxTokens <= 0) fail('ROUTE_UNAUTHORIZED', p + '.maxTokens', 'Explicit positive maxTokens required')
      lanes[lane] = { provider, model, maxTokens: r.maxTokens }
      if (Object.hasOwn(r, 'reasoningEffort')) {
        if (typeof r.reasoningEffort !== 'string' || r.reasoningEffort.trim() !== r.reasoningEffort || !/^[a-z][a-z0-9_-]*$/.test(r.reasoningEffort)) fail('ROUTE_UNAUTHORIZED', p + '.reasoningEffort', 'Expected explicit effort string; Host validates capability')
        lanes[lane].reasoningEffort = r.reasoningEffort
      }
    }
  } else if (enabled) fail('ROUTE_UNAUTHORIZED', '$.lanes', 'Both review routes required')
  if (lanes.practical && lanes.adversarial && normalizeModelId(lanes.practical.model) === normalizeModelId(lanes.adversarial.model)) fail('ROUTE_UNAUTHORIZED', '$.lanes', 'Two distinct normalized models required across providers')
  return { enabled, storageBackend, backend, callBudget, lanes }
}
