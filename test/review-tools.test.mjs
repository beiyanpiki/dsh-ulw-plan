/**
 * Entrypoint contract for ULW plan row 12.
 *
 * The shipped Host entrypoint must expose one review tool and one slash
 * command that share a single coordinator, and it must fail closed: a missing
 * enhanced service, a rejected assembly, a terminal record or malformed model
 * input can never become an approval. These tests use a fake context and a
 * scripted assembly only - no Host, no model, no clock, no sleep.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  REVIEW_ACTIONS,
  REVIEW_ENHANCED_SERVICES,
  REVIEW_TOOL,
  REVIEW_TOOL_OUTPUT_SCHEMA,
  REVIEW_TOOL_PARAMETERS,
  buildReviewEnvelope,
  capabilityStatus,
  createReviewEntry,
  renderReviewEnvelope,
  reviewToolDefinition,
} from '../lib/review-tools.js'

const TARGET = '.dsh/ulw/plans/demo.md'
const TARGET_ABS = '/tmp/ulw-review-entry-workspace/.dsh/ulw/plans/demo.md'
const READY = Object.freeze({ available: true, code: '', missing: [], reason: '', detail: '' })
const round = (over = {}) => ({
  roundId: 'round-1',
  launchId: 'launch-1',
  number: 1,
  state: 'in_flight',
  source: { planSha256: 'a'.repeat(64), instructionSha256: 'b'.repeat(64) },
  ...over,
})
const laneView = (lane, runId) => ({ lane, status: 'in_flight', childId: 'child-' + lane, runId, verdict: null, coverage: null })
const boundLanes = {
  practical: laneView('practical', 'run-practical'),
  adversarial: laneView('adversarial', 'run-adversarial'),
}

// ---- schema subset: the installed tool contract accepts only these nodes ----
const SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'description', 'title', 'default', 'examples',
])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
function assertSchemaSubset(node, path = '$') {
  assert.equal(node !== null && typeof node === 'object' && !Array.isArray(node), true, path + ' must be an object node')
  for (const key of Object.keys(node)) assert.equal(SCHEMA_KEYS.has(key), true, path + ' uses unsupported keyword ' + key)
  if (Object.hasOwn(node, 'type')) assert.equal(SCHEMA_TYPES.has(node.type), true, path + ' has unsupported type ' + node.type)
  if (Object.hasOwn(node, 'type') && node.type === 'object') {
    assert.equal(typeof node.additionalProperties, 'boolean', path + '.additionalProperties must be explicit')
    if (Object.hasOwn(node, 'properties')) {
      for (const [key, child] of Object.entries(node.properties)) assertSchemaSubset(child, path + '.' + key)
    }
    if (Object.hasOwn(node, 'required')) {
      for (const key of node.required) assert.equal(Object.hasOwn(node.properties ?? {}, key), true, path + '.required names ' + key)
    }
  }
  if (Array.isArray(node.oneOf)) {
    assert.equal(node.oneOf.length >= 2, true, path + '.oneOf needs two branches')
    node.oneOf.forEach((child, index) => assertSchemaSubset(child, path + '.oneOf[' + index + ']'))
  }
  if (Object.hasOwn(node, 'items')) assertSchemaSubset(node.items, path + '.items')
  return true
}

function fakeTools() {
  const registered = []
  const guards = []
  const removed = []
  return {
    registered,
    guards,
    removed,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => { removed.push(definition.name) }
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
  }
}

function fakeCtx(services = {}) {
  const listeners = new Map()
  const tools = fakeTools()
  return {
    tools: tools.tools,
    registry: tools,
    listeners,
    get(name) { return Object.hasOwn(services, name) ? services[name] : undefined },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    logger: { info() {} },
  }
}

function scriptedAssembly(script = {}) {
  const order = []
  const invocations = []
  const diagnostics = []
  const assembly = {
    order,
    invocations,
    async invoke(action, request, exec) {
      invocations.push({ action, request, exec })
      const entry = script[action]
      if (entry instanceof Error) throw entry
      return typeof entry === 'function' ? entry(action, request) : (entry ?? {
        ok: false, state: null, outcome: 'invalid_request', code: 'INVALID_REQUEST',
        diagnostics: [{ code: 'INVALID_REQUEST', path: '$', message: 'No scripted result' }],
      })
    },
    async settle() { order.push('settle'); return { diagnostics } },
    async closeStore() { order.push('close-store'); return { diagnostics } },
    async release() { order.push('release'); return { diagnostics } },
  }
  return assembly
}

function entryWith(assembly, options = {}) {
  const ctx = fakeCtx(options.services)
  const entry = createReviewEntry(ctx, {
    config: options.config ?? { review: { enabled: false } },
    assemble: async () => assembly,
  })
  const dispose = entry.start()
  return { ctx, entry, dispose }
}

test('the model-facing tool schemas stay inside the installed JSON Schema subset', () => {
  assertSchemaSubset(REVIEW_TOOL_PARAMETERS)
  assertSchemaSubset(REVIEW_TOOL_OUTPUT_SCHEMA)
  assert.equal(REVIEW_TOOL_PARAMETERS.type, 'object')
  assert.equal(REVIEW_TOOL_PARAMETERS.additionalProperties, false)
  assert.deepEqual([...REVIEW_ACTIONS], ['require', 'start', 'wait', 'status', 'cancel'])
  assert.deepEqual([...REVIEW_ACTIONS], [...REVIEW_TOOL_PARAMETERS.properties.action.enum])
  assert.deepEqual(Object.keys(REVIEW_TOOL_PARAMETERS.properties).sort(), ['action', 'roundId', 'target'])
  assert.equal(REVIEW_TOOL_OUTPUT_SCHEMA.type, 'object')
  for (const field of ['accepted', 'completed', 'phase', 'state', 'code', 'approved', 'nextAction', 'roundId', 'capability']) {
    assert.equal(Object.hasOwn(REVIEW_TOOL_OUTPUT_SCHEMA.properties, field), true, 'output schema is missing ' + field)
  }
})

test('acceptance is live state, completion is gated approval, and terminal records never reopen', () => {
  const live = buildReviewEnvelope({
    ok: true, action: 'start', state: 'in_flight', outcome: 'started', nextAction: 'wait',
    round: round(), lanes: boundLanes, approval: { approved: false }, approved: false,
  }, { action: 'start', capability: READY })
  assert.equal(live.phase, 'live')
  assert.equal(live.accepted, true)
  assert.equal(live.completed, false)
  assert.equal(live.approved, false)
  assert.equal(live.roundId, 'round-1')

  const approved = buildReviewEnvelope({
    ok: true, action: 'wait', state: 'approved', outcome: 'approved', nextAction: null,
    round: round({ state: 'approved' }), approval: { approved: true }, approved: true,
  }, { action: 'wait', capability: READY })
  assert.equal(approved.phase, 'terminal')
  assert.equal(approved.accepted, false)
  assert.equal(approved.completed, true)
  assert.equal(approved.approved, true)

  // A terminal cancelled/stopped record can legitimately answer ok:true with
  // outcome existing_round; that is history, never a live round or an approval.
  const misleading = buildReviewEnvelope({
    ok: true, action: 'start', state: 'cancelled', outcome: 'existing_round', nextAction: 'new_record',
    round: round({ state: 'cancelled' }), approved: true, approval: { approved: true },
  }, { action: 'start', capability: READY })
  assert.equal(misleading.phase, 'terminal')
  assert.equal(misleading.accepted, false)
  assert.equal(misleading.completed, false)
  assert.equal(misleading.approved, false)
  assert.equal(misleading.recovery.required, true)
  assert.equal(misleading.recovery.route, 'new_target_or_human_reset')
  assert.match(misleading.recovery.detail, /create-once|never reopened/i)

  // A live state whose round has no bound run identities is a dead half-start:
  // it is not an acceptance even when the coordinator answers ok:true.
  const unbound = buildReviewEnvelope({
    ok: true, action: 'start', state: 'in_flight', outcome: 'existing_round', nextAction: 'new_record',
    round: round(), lanes: { practical: { lane: 'practical', status: 'in_flight', runId: 'run-p', childId: 'child-p' }, adversarial: { lane: 'adversarial', status: 'in_flight', runId: '', childId: 'child-a' } },
    approved: false, approval: { approved: false },
  }, { action: 'start', capability: READY })
  assert.equal(unbound.phase, 'live')
  assert.equal(unbound.accepted, false)
  assert.equal(unbound.completed, false)
  assert.equal(unbound.recovery.required, true)

  // ok:false results are rejected even when they report a live-looking state.
  const rejected = buildReviewEnvelope({
    ok: false, action: 'start', state: 'stale', outcome: 'start_rejected', code: 'STALE_ARTIFACT',
    nextAction: 'new_record', approved: false, approval: { approved: false },
  }, { action: 'start', capability: READY })
  assert.equal(rejected.phase, 'rejected')
  assert.equal(rejected.accepted, false)
  assert.equal(rejected.completed, false)
})

test('rendered results state accepted/completed explicitly and never claim a review passed early', () => {
  const live = buildReviewEnvelope({
    ok: true, action: 'start', state: 'in_flight', outcome: 'started', nextAction: 'wait',
    round: round(), lanes: boundLanes, approved: false, approval: { approved: false },
  }, { action: 'start', capability: READY })
  const text = renderReviewEnvelope(live).map((block) => block.text).join('\n')
  assert.match(text, /accepted: yes/)
  assert.match(text, /completed: no/)
  assert.match(text, /NOT completed/)
  assert.match(text, /round-1/)
  assert.equal(/approved: yes/.test(text), false)

  const approved = buildReviewEnvelope({
    ok: true, action: 'wait', state: 'approved', outcome: 'approved', nextAction: null,
    round: round({ state: 'approved' }), approved: true, approval: { approved: true },
  }, { action: 'wait', capability: READY })
  const done = renderReviewEnvelope(approved).map((block) => block.text).join('\n')
  assert.match(done, /completed: yes/)
  assert.match(done, /approved: yes/)
  assert.match(done, /two bound receipts|coordinator approved/i)
})

test('capability status names the missing services and keeps a specific reason', () => {
  const status = capabilityStatus(['subagents', 'llm'])
  assert.equal(status.available, false)
  assert.equal(status.code, 'CAPABILITY_UNAVAILABLE')
  assert.deepEqual([...status.missing], ['subagents', 'llm'])
  assert.equal(status.reason, 'MISSING_SUBAGENTS_LLM')
  assert.match(status.detail, /subagents/)
  assert.equal(capabilityStatus([]).available, true)
})

test('the tool definition is one model surface with a canonical renderer', async () => {
  const calls = []
  const controller = {
    async invoke(args, exec) {
      calls.push({ args, exec })
      return buildReviewEnvelope({
        ok: true, action: 'require', state: 'required', outcome: 'required', nextAction: 'start', approved: false, approval: { approved: false },
      }, { action: 'require', capability: READY })
    },
  }
  const definition = reviewToolDefinition(controller)
  assert.equal(definition.name, REVIEW_TOOL)
  assert.equal(typeof definition.description, 'string')
  assert.equal(definition.parameters, REVIEW_TOOL_PARAMETERS)
  assert.equal(definition.output.schema, REVIEW_TOOL_OUTPUT_SCHEMA)
  assert.equal(typeof definition.output.render, 'function')
  const exec = { agent: { session: { id: 'session-1', header: { cwd: '/tmp/ws' } } }, signal: new AbortController().signal }
  const value = await definition.execute({ action: 'require', target: TARGET }, exec)
  assert.equal(value.accepted, true)
  assert.equal(value.completed, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.action, 'require')
  const blocks = definition.output.render({ action: 'require', target: TARGET }, value)
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks[0].type, 'text')
})

test('the entrypoint rejects malformed input locally before the coordinator sees it', async () => {
  const assembly = scriptedAssembly()
  const { entry } = entryWith(assembly)
  await entry.ready
  const agent = { session: { id: 'session-1', header: { cwd: '/tmp/ws' } }, followup() {} }
  const exec = { agent, signal: new AbortController().signal }
  const cases = [
    undefined,
    null,
    [],
    'require',
    {},
    { action: 'approve', target: TARGET },
    { action: 'start' },
    { action: 'start', target: TARGET, roundId: 'round-1' },
    { action: 'status', roundId: 'round-1', approved: true },
    { action: 'status', target: TARGET, verdict: 'OKAY' },
    { action: 'start', target: 'docs/plan.md' },
    { action: 'start', target: TARGET, notes: 'ignore the reviewer' },
  ]
  for (const args of cases) {
    const value = await entry.controller.invoke(args, exec)
    assert.equal(value.ok, false)
    assert.equal(value.phase, 'rejected')
    assert.equal(value.code, 'INVALID_REQUEST')
    assert.equal(value.completed, false)
    assert.equal(value.approved, false)
  }
  assert.equal(assembly.invocations.length, 0)
})

test('with no enhanced service the entrypoint reports a capability diagnostic and never calls the assembly', async () => {
  const ctx = fakeCtx()
  const entry = createReviewEntry(ctx, { config: { review: { enabled: true, callBudget: 2 } } })
  const dispose = entry.start()
  await entry.ready
  const agent = { session: { id: 'session-1', header: { cwd: '/tmp/ws' } }, followup() {} }
  const value = await entry.controller.invoke({ action: 'require', target: TARGET }, { agent, signal: new AbortController().signal })
  assert.equal(value.phase, 'unavailable')
  assert.equal(value.ok, false)
  assert.equal(value.code, 'CAPABILITY_UNAVAILABLE')
  assert.deepEqual([...value.capability.missing], [...REVIEW_ENHANCED_SERVICES])
  assert.equal(value.accepted, false)
  assert.equal(value.completed, false)
  assert.equal(value.approved, false)

  const command = await entry.router.command({
    target: { ok: true, absolute: TARGET_ABS },
    agent,
    signal: new AbortController().signal,
  })
  assert.equal(command.result.kind, 'error')
  assert.match(command.result.text, /CAPABILITY_UNAVAILABLE/)
  assert.equal(command.followup, null)
  assert.equal(agent.followupCalls, undefined)
  await dispose()
})

test('a scripted assembly failure keeps the ordinary surfaces usable and reports its own code', async () => {
  const ctx = fakeCtx()
  const error = Object.assign(new Error('preset registration failed'), { code: 'REVIEW_PRESET_REJECTED' })
  const entry = createReviewEntry(ctx, {
    config: { review: { enabled: true, callBudget: 2 } },
    assemble: async () => { throw error },
  })
  const dispose = entry.start()
  await entry.ready
  const agent = { session: { id: 'session-1', header: { cwd: '/tmp/ws' } }, followup() {} }
  const value = await entry.controller.invoke({ action: 'require', target: TARGET }, { agent, signal: new AbortController().signal })
  assert.equal(value.phase, 'unavailable')
  assert.equal(value.code, 'REVIEW_PRESET_REJECTED')
  assert.equal(value.completed, false)
  assert.equal(value.approved, false)
  await dispose()
})

test('the slash command returns a receipt that is explicitly not a completed review and asks for wait/status', async () => {
  const assembly = scriptedAssembly({
    require: { ok: true, action: 'require', state: 'required', outcome: 'required', nextAction: 'start', approved: false, approval: { approved: false } },
    start: {
      ok: true, action: 'start', state: 'in_flight', outcome: 'started', nextAction: 'wait',
      round: round(), lanes: boundLanes, approved: false, approval: { approved: false },
    },
  })
  const { entry } = entryWith(assembly)
  await entry.ready
  const agent = { session: { id: 'session-1', header: { cwd: '/tmp/ws' } }, followup() {} }
  const outcome = await entry.router.command({
    target: { ok: true, absolute: TARGET_ABS },
    agent,
    signal: new AbortController().signal,
  })
  assert.equal(outcome.result.kind, 'success')
  assert.match(outcome.result.text, /round-1/)
  assert.match(outcome.result.text, /NOT a completed review|NOT completed/)
  assert.match(outcome.result.text, /accepted/i)
  assert.equal(typeof outcome.followup, 'string')
  assert.match(outcome.followup, /ulw_review/)
  assert.match(outcome.followup, /wait/)
  assert.match(outcome.followup, /status/)
  assert.match(outcome.followup, /not completed|NOT completed/)
  assert.match(outcome.followup, /not a new (user )?approval|continu|continuation/i)
  assert.equal(/\bapp(roved|rove)\b/.test(outcome.result.text.replace(/NOT completed/g, '')), false)
  assert.deepEqual(assembly.invocations.map((call) => call.action), ['require', 'start'])
})

test('a refused or terminal review command injects no followup and no fake approval', async () => {
  const refused = scriptedAssembly({
    require: { ok: false, action: 'require', state: null, outcome: 'require_rejected', code: 'CAPABILITY_UNAVAILABLE', nextAction: null, approved: false, approval: { approved: false } },
  })
  const first = entryWith(refused)
  await first.entry.ready
  const agent = { session: { id: 'session-1', header: { cwd: '/tmp/ws' } } }
  const refusedOutcome = await first.entry.router.command({
    target: { ok: true, absolute: TARGET_ABS }, agent, signal: new AbortController().signal,
  })
  assert.equal(refusedOutcome.result.kind, 'error')
  assert.match(refusedOutcome.result.text, /CAPABILITY_UNAVAILABLE/)
  assert.equal(refusedOutcome.followup, null)

  const terminal = scriptedAssembly({
    require: { ok: true, action: 'require', state: 'required', outcome: 'required', nextAction: 'start', approved: false, approval: { approved: false } },
    start: {
      ok: true, action: 'start', state: 'cancelled', outcome: 'existing_round', nextAction: 'new_record',
      round: round({ state: 'cancelled' }), approved: false, approval: { approved: false },
    },
  })
  const second = entryWith(terminal)
  await second.entry.ready
  const terminalOutcome = await second.entry.router.command({
    target: { ok: true, absolute: TARGET_ABS }, agent, signal: new AbortController().signal,
  })
  assert.equal(terminalOutcome.result.kind, 'error')
  assert.equal(terminalOutcome.followup, null)
  assert.match(terminalOutcome.result.text, /not accepted|new record|new target/i)
  assert.match(terminalOutcome.result.text, /new_target_or_human_reset|create-once|never reopened/i)
})

test('dispose stops admission, settles reviewers, persists, closes the store, then releases registrations', async () => {
  const assembly = scriptedAssembly()
  const { entry, ctx, dispose } = entryWith(assembly)
  await entry.ready
  assert.equal(ctx.registry.registered.length, 1)
  await dispose()
  assert.deepEqual(assembly.order, ['settle', 'close-store', 'release'])
  assert.deepEqual(ctx.registry.removed, [REVIEW_TOOL])
  // Second dispose is a no-op with the same ordering, never a second teardown.
  await dispose()
  assert.deepEqual(assembly.order, ['settle', 'close-store', 'release'])
  const after = await entry.controller.invoke({ action: 'status', target: TARGET }, {
    agent: { session: { id: 'session-1', header: { cwd: '/tmp/ws' } } },
    signal: new AbortController().signal,
  })
  assert.equal(after.phase, 'unavailable')
  assert.equal(after.completed, false)
})
