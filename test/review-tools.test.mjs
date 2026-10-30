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
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  HANDOFF_ACTIONS,
  HANDOFF_TOOL,
  HANDOFF_TOOL_OUTPUT_SCHEMA,
  HANDOFF_TOOL_PARAMETERS,
  REVIEW_ACTIONS,
  REVIEW_ENHANCED_SERVICES,
  REVIEW_TOOL,
  REVIEW_TOOL_OUTPUT_SCHEMA,
  REVIEW_TOOL_PARAMETERS,
  buildReviewEnvelope,
  capabilityStatus,
  createReviewEntry,
  handoffToolDefinition,
  renderHandoffEnvelope,
  renderReviewEnvelope,
  reviewLeaseGate,
  reviewToolDefinition,
} from '../lib/review-tools.js'
import { ULW_REVIEW_COMMAND, activeExecuteLease, registerCommands } from '../lib/commands.js'

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

function scriptedAssembly(script = {}, options = {}) {
  const order = []
  const invocations = []
  const handoffCalls = []
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
  if (options.handoff === true) {
    const scripted = options.handoffScript ?? {}
    assembly.handoff = {
      calls: handoffCalls,
      async invoke(action, request, exec) {
        handoffCalls.push({ action, request, exec })
        const entry = scripted[action]
        if (entry instanceof Error) throw entry
        if (entry !== undefined) return entry
        return {
          ok: true, action, outcome: 'ordinary_lease', code: null, nextAction: 'execute',
          target: request.target, handoffId: 'handoff-test', required: false,
          lease: { handoffId: 'handoff-test', planSha256: 'a'.repeat(64), instructionSha256: 'b'.repeat(64), approvedRoundId: null, approvedSourceSha256: null, reviewedAt: null, expiresAt: null, required: false, target: request.target },
          receipt: null, binding: null, diagnostics: [],
        }
      },
      async dispose() { order.push('handoff:dispose') },
    }
  }
  return assembly
}

const EXEC_AGENT = { session: { id: 'session-1', header: { cwd: '/tmp/ws' } }, followup() {} }
const execFor = (agent = EXEC_AGENT) => ({ agent, signal: new AbortController().signal })

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
  assert.equal(ctx.registry.registered.length, 2)
  await dispose()
  assert.deepEqual(assembly.order, ['settle', 'close-store', 'release'])
  assert.deepEqual(ctx.registry.removed, [REVIEW_TOOL, HANDOFF_TOOL])
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

// ---------------------------------------------------------------------------
// ULW row 27: the assembled handoff service and the ulw_handoff tool
// ---------------------------------------------------------------------------

test('ulw_handoff is one selector-only tool inside the installed JSON Schema subset', () => {
  assertSchemaSubset(HANDOFF_TOOL_PARAMETERS)
  assertSchemaSubset(HANDOFF_TOOL_OUTPUT_SCHEMA)
  assert.equal(HANDOFF_TOOL_PARAMETERS.type, 'object')
  assert.equal(HANDOFF_TOOL_PARAMETERS.additionalProperties, false)
  assert.deepEqual([...HANDOFF_ACTIONS], ['check', 'bootstrap', 'bind-worktree'])
  assert.deepEqual([...HANDOFF_ACTIONS], [...HANDOFF_TOOL_PARAMETERS.properties.action.enum])
  assert.deepEqual(Object.keys(HANDOFF_TOOL_PARAMETERS.properties).sort(), ['action', 'target', 'worktreePath'])
  assert.equal(HANDOFF_TOOL_PARAMETERS.required.includes('action'), true)
  assert.equal(HANDOFF_TOOL_PARAMETERS.required.includes('target'), true)
  for (const field of ['ok', 'action', 'outcome', 'code', 'nextAction', 'target', 'required', 'handoffId', 'lease', 'receipt', 'binding', 'capability', 'diagnostics', 'detail']) {
    assert.equal(Object.hasOwn(HANDOFF_TOOL_OUTPUT_SCHEMA.properties, field), true, 'output schema is missing ' + field)
  }
  const definition = handoffToolDefinition({ async invoke() { return { ok: false } } })
  assert.equal(definition.name, HANDOFF_TOOL)
  assert.equal(definition.parameters, HANDOFF_TOOL_PARAMETERS)
  assert.equal(definition.output.schema, HANDOFF_TOOL_OUTPUT_SCHEMA)
  assert.deepEqual(definition.output.render({}, { ok: true, action: 'check', required: false, nextAction: 'execute' })[0].type, 'text')
})

test('the entrypoint registers ulw_handoff immediately and fails closed until a real service is attached', async () => {
  const ctx = fakeCtx()
  const entry = createReviewEntry(ctx, { config: {}, assemble: async () => scriptedAssembly() })
  const dispose = entry.start()
  assert.deepEqual(ctx.registry.registered.map((definition) => definition.name), [REVIEW_TOOL, HANDOFF_TOOL])

  const pending = await entry.handoff.invoke({ action: 'check', target: TARGET }, execFor())
  assert.equal(pending.ok, false)
  assert.equal(pending.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(pending.capability.available, false)
  assert.equal(pending.capability.reason, 'HANDOFF_ASSEMBLY_PENDING')
  assert.equal(pending.lease, null)

  await entry.ready
  const half = await entry.handoff.invoke({ action: 'check', target: TARGET }, execFor())
  assert.equal(half.ok, false)
  assert.equal(half.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(half.capability.reason, 'HANDOFF_ASSEMBLY_INCOMPLETE')
  assert.equal(half.lease, null)

  await dispose()
  assert.deepEqual(ctx.registry.removed, [REVIEW_TOOL, HANDOFF_TOOL])
  const after = await entry.handoff.invoke({ action: 'check', target: TARGET }, execFor())
  assert.equal(after.ok, false)
  assert.equal(after.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(after.capability.reason, 'HANDOFF_SHUTTING_DOWN')
  const again = await dispose()
  assert.deepEqual(ctx.registry.removed, [REVIEW_TOOL, HANDOFF_TOOL], 'a second dispose never re-registers or re-removes')
  assert.deepEqual(again, { diagnostics: [] })
})

test('forged or malformed handoff parameters are refused before any service call', async () => {
  const assembly = scriptedAssembly({}, { handoff: true })
  const { entry } = entryWith(assembly)
  await entry.ready
  const cases = [
    undefined,
    null,
    [],
    'check',
    {},
    { action: 'approve', target: TARGET },
    { action: 'check' },
    { action: 'bootstrap' },
    { action: 'check', target: TARGET, worktreePath: '/tmp/wt' },
    { action: 'bind-worktree', target: TARGET },
    { action: 'bind-worktree', target: TARGET, worktreePath: 'relative/wt' },
    { action: 'check', target: TARGET, approved: true },
    { action: 'check', target: TARGET, pinDelegated: false },
    { action: 'bootstrap', target: TARGET, delegated: true },
    { action: 'check', target: 'docs/plan.md' },
  ]
  for (const args of cases) {
    const value = await entry.handoff.invoke(args, execFor())
    assert.equal(value.ok, false, JSON.stringify(args))
    assert.equal(value.code, 'HANDOFF_INVALID_REQUEST', JSON.stringify(args))
    assert.equal(value.capability.available, true)
    assert.equal(value.lease, null)
    assert.equal(value.required, false)
  }
  assert.equal(assembly.handoff.calls.length, 0, 'no forged selector may reach the service')

  const valid = await entry.handoff.invoke({ action: 'check', target: TARGET }, execFor())
  assert.equal(valid.ok, true)
  assert.equal(valid.required, false)
  assert.equal(valid.capability.available, true)
  assert.equal(valid.lease.handoffId, 'handoff-test')
  assert.deepEqual(assembly.handoff.calls.map((call) => call.action), ['check'])
  assert.deepEqual(assembly.handoff.calls[0].request, { action: 'check', target: TARGET })
  const rendered = handoffToolDefinition(entry.handoff).output.render({}, valid).map((block) => block.text).join('\n')
  assert.match(rendered, /ulw_handoff check/)
  assert.match(rendered, /handoff-test/)
  assert.match(rendered, /nextAction: execute/)
})

test('dispose revokes the handoff before reviewers settle and unregisters the tools last', async () => {
  const assembly = scriptedAssembly({}, { handoff: true })
  const { entry, ctx, dispose } = entryWith(assembly)
  await entry.ready
  await dispose()
  assert.deepEqual(assembly.order, ['handoff:dispose', 'settle', 'close-store', 'release'])
  assert.deepEqual(ctx.registry.removed, [REVIEW_TOOL, HANDOFF_TOOL])
  await dispose()
  assert.deepEqual(assembly.order, ['handoff:dispose', 'settle', 'close-store', 'release'], 'idempotent dispose performs no second teardown')
})

test('a failed assembly surfaces one stable capability code on ulw_handoff, never a lease', async () => {
  const ctx = fakeCtx()
  const failure = Object.assign(new Error('store unavailable'), { code: 'STORE_UNAVAILABLE' })
  const entry = createReviewEntry(ctx, { config: {}, assemble: async () => { throw failure } })
  const dispose = entry.start()
  await entry.ready
  const value = await entry.handoff.invoke({ action: 'bootstrap', target: TARGET }, execFor())
  assert.equal(value.ok, false)
  assert.equal(value.code, 'STORE_UNAVAILABLE')
  assert.equal(value.capability.available, false)
  assert.equal(value.lease, null)
  assert.equal(value.receipt, null)
  await dispose()
})

test('a half-assembled enhanced install gates product writes and answers one capability code', async () => {
  const ctx = fakeCtx({ subagents: {}, agentPresets: {}, llm: {}, storage: {} })
  const entry = createReviewEntry(ctx, { config: {}, assemble: async () => null })
  const dispose = entry.start()
  await entry.ready
  assert.equal(typeof ctx.handoff?.guard, 'function', 'the failed enhanced assembly installs a refusing guard')
  const writeReason = ctx.handoff.guard({
    agent: { session: { id: 'session-1', header: { cwd: '/tmp/ws' } } },
    name: 'write',
    arguments: { file_path: 'src/main.js' },
  })
  assert.match(writeReason ?? '', /HANDOFF_REVIEW_UNAVAILABLE/)
  assert.equal(ctx.handoff.guard({
    agent: { session: { id: 'session-1', header: { cwd: '/tmp/ws' } } },
    name: 'ulw_handoff',
    arguments: {},
  }), undefined)
  const value = await entry.handoff.invoke({ action: 'check', target: TARGET }, execFor())
  assert.equal(value.ok, false)
  assert.equal(value.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(value.lease, null)
  await dispose()
  assert.equal(ctx.handoff, undefined)
})

test('a second start never double-assembles or double-registers the handoff tool', async () => {
  const assembly = scriptedAssembly({}, { handoff: true })
  const ctx = fakeCtx()
  const entry = createReviewEntry(ctx, { config: {}, assemble: async () => assembly })
  const first = entry.start()
  const second = entry.start()
  await entry.ready
  assert.deepEqual(ctx.registry.registered.map((definition) => definition.name), [REVIEW_TOOL, HANDOFF_TOOL])
  const value = await entry.handoff.invoke({ action: 'check', target: TARGET }, execFor())
  assert.equal(value.ok, true)
  await first()
  await second()
  assert.deepEqual(assembly.order, ['handoff:dispose', 'settle', 'close-store', 'release'])
  assert.deepEqual(ctx.registry.removed, [REVIEW_TOOL, HANDOFF_TOOL])
})
// ---------------------------------------------------------------------------
// ULW row 34: ulw_review shares the command's active-execute lease rule
// ---------------------------------------------------------------------------

/** One handoff snapshot as the authority reports it (leased or bound). */
function executeLeaseSnapshot(overrides = {}) {
  return {
    status: 'leased',
    required: true,
    lease: { handoffId: 'handoff-test-1', required: true },
    ...overrides,
  }
}

/**
 * An entry whose session projects one mode and whose Host-owned handoff
 * answers a scripted lease snapshot. The real shipped entry reads exactly
 * these two surfaces (ctx.handoff, ctx.sessionProjections), so this exercises
 * the same rule the slash command applies.
 */
function leaseEntry(mode, snapshots = {}, options = {}) {
  const ctx = fakeCtx()
  const calls = []
  ctx.sessionProjections = { stateOf: (_session, key) => (key === 'ulwMode' ? { mode } : undefined) }
  ctx.handoff = {
    calls,
    stateForSession(sessionId) {
      calls.push(sessionId)
      if (options.throw === true) throw new Error('handoff lease state unavailable')
      if (options.async === true) return Promise.resolve(snapshots[sessionId] ?? null)
      return snapshots[sessionId] ?? null
    },
  }
  const assembly = scriptedAssembly(options.script ?? {})
  const entry = createReviewEntry(ctx, {
    config: { review: { enabled: true, callBudget: 2 } },
    assemble: async () => assembly,
  })
  const dispose = entry.start()
  return { ctx, calls, assembly, entry, dispose }
}

const reviewAgent = () => ({ session: { id: 'session-1', header: { cwd: '/tmp/ws' } } })

test('row 34: an active execute lease refuses require and start with HANDOFF_ACTIVE_EXECUTE', async () => {
  for (const status of ['leased', 'bound']) {
    const { entry, assembly, dispose } = leaseEntry('execute', { 'session-1': executeLeaseSnapshot({ status }) })
    await entry.ready
    for (const action of ['require', 'start']) {
      const value = await entry.controller.invoke({ action, target: TARGET }, execFor())
      assert.equal(value.ok, false, action + '/' + status)
      assert.equal(value.phase, 'rejected', action + '/' + status)
      assert.equal(value.code, 'HANDOFF_ACTIVE_EXECUTE', action + '/' + status)
      assert.equal(value.accepted, false, action + '/' + status)
      assert.equal(value.completed, false)
      assert.equal(value.approved, false)
      assert.equal(value.roundId, '', 'a refusal never exposes a round id')
      assert.deepEqual(value.diagnostics.map((entry) => entry.code), ['HANDOFF_ACTIVE_EXECUTE'])
      const rendered = renderReviewEnvelope(value).map((block) => block.text).join('\n')
      assert.match(rendered, /HANDOFF_ACTIVE_EXECUTE/)
      assert.match(rendered, /completed: no/)
      assert.equal(/accepted but NOT completed|accepted round/.test(rendered), false, 'a refusal never reads as an accepted round')
    }
    assert.equal(assembly.invocations.length, 0, 'the gate refuses before the coordinator can create a round or activation')
    await dispose()
  }
})

test('row 34: the command router refuses inside the same lease and returns no receipt', async () => {
  const { entry, assembly, dispose } = leaseEntry('execute', { 'session-1': executeLeaseSnapshot() })
  await entry.ready
  const outcome = await entry.router.command({
    target: { ok: true, absolute: TARGET_ABS },
    agent: reviewAgent(),
    signal: new AbortController().signal,
  })
  assert.equal(outcome.result.kind, 'error')
  assert.match(outcome.result.text, /HANDOFF_ACTIVE_EXECUTE/)
  assert.equal(outcome.result.text.includes('CAPABILITY_UNAVAILABLE'), false, 'the lease refusal keeps its own stable code')
  assert.equal(/accepted round|NOT a completed review/.test(outcome.result.text), false, 'a refusal never fabricates a receipt')
  assert.equal(outcome.followup, null)
  assert.equal(assembly.invocations.length, 0)
  await dispose()
})

test('row 34: execute without a lease, plan and off still accept the requirement; only execute reads the lease', async () => {
  const required = { ok: true, action: 'require', state: 'required', outcome: 'required', nextAction: 'start', approved: false, approval: { approved: false } }

  // execute, no handoff at all: an old Host keeps row 12 behaviour.
  const oldHost = leaseEntry('execute', {}, { script: { require: required } })
  await oldHost.entry.ready
  const oldValue = await oldHost.entry.controller.invoke({ action: 'require', target: TARGET }, execFor())
  assert.equal(oldValue.phase, 'live')
  assert.equal(oldValue.accepted, true)
  assert.equal(oldHost.assembly.invocations.length, 1)
  await oldHost.dispose()

  // execute with a handoff that knows no lease for this session: accepted, consulted once.
  const noLease = leaseEntry('execute', {}, { script: { require: required } })
  await noLease.entry.ready
  const noLeaseValue = await noLease.entry.controller.invoke({ action: 'require', target: TARGET }, execFor())
  assert.equal(noLeaseValue.phase, 'live')
  assert.equal(noLeaseValue.accepted, true)
  assert.deepEqual(noLease.calls, ['session-1'])
  await noLease.dispose()

  // plan and off: the lingering execute lease is irrelevant, exactly like the command.
  for (const mode of ['plan', 'off']) {
    const accepted = leaseEntry(mode, { 'session-1': executeLeaseSnapshot() }, { script: { require: required } })
    await accepted.entry.ready
    const value = await accepted.entry.controller.invoke({ action: 'require', target: TARGET }, execFor())
    assert.equal(value.phase, 'live', mode)
    assert.equal(value.accepted, true, mode)
    assert.equal(value.code, '', mode)
    assert.deepEqual(accepted.calls, [], mode + ' must not consult the execute lease')
    await accepted.dispose()
  }
})

test('row 34: an unreadable or asynchronous lease lookup fails closed with CAPABILITY_UNAVAILABLE', async () => {
  for (const [name, options] of [['throwing', { throw: true }], ['asynchronous', { async: true }]]) {
    const { entry, assembly, dispose } = leaseEntry('execute', { 'session-1': executeLeaseSnapshot() }, options)
    await entry.ready
    for (const action of ['require', 'start']) {
      const value = await entry.controller.invoke({ action, target: TARGET }, execFor())
      assert.equal(value.ok, false, name + '/' + action)
      assert.equal(value.phase, 'rejected', name + '/' + action)
      assert.equal(value.code, 'CAPABILITY_UNAVAILABLE', name + '/' + action)
      assert.equal(value.code === 'HANDOFF_ACTIVE_EXECUTE', false, 'a failed lookup is not a lease refusal')
      assert.equal(value.accepted, false)
      assert.equal(value.roundId, '')
    }
    const outcome = await entry.router.command({
      target: { ok: true, absolute: TARGET_ABS },
      agent: reviewAgent(),
      signal: new AbortController().signal,
    })
    assert.equal(outcome.result.kind, 'error')
    assert.match(outcome.result.text, /CAPABILITY_UNAVAILABLE/)
    assert.equal(outcome.followup, null)
    assert.equal(assembly.invocations.length, 0, name + ' never reaches the coordinator')
    await dispose()
  }
})

test('row 34: status, wait and cancel keep their semantics while an execute lease is active', async () => {
  const live = {
    ok: true, state: 'in_flight', outcome: 'in_flight', round: round(), lanes: boundLanes,
    approved: false, approval: { approved: false },
  }
  const script = {
    status: { ...live, action: 'status' },
    wait: { ...live, action: 'wait' },
    cancel: {
      ok: true, action: 'cancel', state: 'cancelled', outcome: 'cancelled',
      round: round({ state: 'cancelled' }), approved: false, approval: { approved: false },
    },
  }
  const { entry, assembly, calls, dispose } = leaseEntry('execute', { 'session-1': executeLeaseSnapshot() }, { script })
  await entry.ready
  const status = await entry.controller.invoke({ action: 'status', roundId: 'round-1' }, execFor())
  assert.equal(status.phase, 'live')
  assert.equal(status.roundId, 'round-1')
  assert.equal(status.accepted, true)
  const waited = await entry.controller.invoke({ action: 'wait', roundId: 'round-1' }, execFor())
  assert.equal(waited.phase, 'live')
  assert.equal(waited.roundId, 'round-1')
  const cancelled = await entry.controller.invoke({ action: 'cancel', roundId: 'round-1' }, execFor())
  assert.equal(cancelled.phase, 'terminal')
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.accepted, false)
  assert.equal(cancelled.completed, false)
  assert.deepEqual(assembly.invocations.map((call) => call.action), ['status', 'wait', 'cancel'])
  assert.deepEqual(calls, [], 'status/wait/cancel never consult the execute lease')
  await dispose()
})
test('row 34/35: the shared lease predicate matches the command for every handoff snapshot', () => {
  const agent = { session: { id: 'session-1', header: { cwd: '/tmp/ws' } } }
  const handoffOf = (value) => ({ calls: [], stateForSession() { this.calls.push('session-1'); return value } })
  // The predicate lives in lib/commands.js and takes the Host context both
  // entries hand it; only its `handoff` member is read.
  const scopeOf = (handoff) => ({ handoff })

  // No authority, no session identity, or no state: nothing can be leased.
  assert.deepEqual(activeExecuteLease(undefined, agent), { known: true, active: false })
  assert.deepEqual(activeExecuteLease({}, agent), { known: true, active: false })
  assert.deepEqual(activeExecuteLease(scopeOf(handoffOf(null)), agent), { known: true, active: false })
  assert.deepEqual(activeExecuteLease(scopeOf(handoffOf(undefined)), agent), { known: true, active: false })
  assert.deepEqual(activeExecuteLease(scopeOf(handoffOf({ status: 'leased', lease: null })), agent), { known: true, active: false })
  assert.deepEqual(activeExecuteLease(scopeOf(handoffOf({ status: 'revoked', lease: { handoffId: 'h' } })), agent), { known: true, active: false })
  assert.deepEqual(activeExecuteLease(scopeOf(handoffOf(executeLeaseSnapshot())), { session: { header: {} } }), { known: true, active: false })

  // A lease in leased or bound status is the one active-execute refusal.
  assert.deepEqual(activeExecuteLease(scopeOf(handoffOf(executeLeaseSnapshot({ status: 'leased' }))), agent), { known: true, active: true })
  assert.deepEqual(activeExecuteLease(scopeOf(handoffOf(executeLeaseSnapshot({ status: 'bound' }))), agent), { known: true, active: true })

  // A throwing, asynchronous or rejecting lookup is never a lease snapshot.
  assert.deepEqual(activeExecuteLease(scopeOf({ stateForSession() { throw new Error('unreadable') } }), agent), { known: false, active: false })
  assert.deepEqual(activeExecuteLease(scopeOf({ stateForSession: async () => executeLeaseSnapshot() }), agent), { known: false, active: false })
  assert.deepEqual(activeExecuteLease(scopeOf({ stateForSession() { return Promise.reject(new Error('rejected')) } }), agent), { known: false, active: false })

  // The mode gate: only execute consults the handoff at all.
  const calls = []
  const ctx = {
    sessionProjections: { stateOf: () => ({ mode: 'plan' }) },
    handoff: { stateForSession(sessionId) { calls.push(sessionId); return executeLeaseSnapshot() } },
  }
  assert.equal(reviewLeaseGate(ctx, agent), null)
  assert.deepEqual(calls, [])
  ctx.sessionProjections = { stateOf: () => ({ mode: 'execute' }) }
  const refused = reviewLeaseGate(ctx, agent)
  assert.equal(refused.code, 'HANDOFF_ACTIVE_EXECUTE')
  assert.match(refused.detail, /ulw_handoff check/)
  ctx.handoff = { stateForSession() { throw new Error('unreadable') } }
  assert.equal(reviewLeaseGate(ctx, agent).code, 'CAPABILITY_UNAVAILABLE')
})

test('row 35 parity: all 15 probed states answer the same code on the command and the tool', () => {
  const agentOf = (session = { id: 'session-1', header: { cwd: '/tmp/ws' } }) => ({ session, followup() {} })
  const handoffOf = (value) => ({ calls: [], stateForSession() { this.calls.push('session-1'); return value } })
  const throwing = { stateForSession() { throw new Error('handoff lease storage unavailable') } }
  const pending = { stateForSession() { return new Promise(() => {}) } }
  const rejecting = { stateForSession() { return Promise.reject(new Error('handoff lease storage unavailable')) } }
  const rows = [
    ['execute/leased', 'execute', handoffOf(executeLeaseSnapshot({ status: 'leased' })), 'HANDOFF_ACTIVE_EXECUTE'],
    ['execute/bound', 'execute', handoffOf(executeLeaseSnapshot({ status: 'bound' })), 'HANDOFF_ACTIVE_EXECUTE'],
    ['execute/revoked', 'execute', handoffOf({ status: 'revoked', lease: { handoffId: 'h' } }), 'ACCEPT'],
    ['execute/cancelled', 'execute', handoffOf({ status: 'cancelled', lease: { handoffId: 'h' } }), 'ACCEPT'],
    ['execute/stale', 'execute', handoffOf({ status: 'stale', lease: { handoffId: 'h' } }), 'ACCEPT'],
    ['execute/required-no-lease', 'execute', handoffOf({ status: 'required', lease: null }), 'ACCEPT'],
    ['execute/no-lease', 'execute', handoffOf({ status: 'off', lease: null }), 'ACCEPT'],
    ['execute/no-state', 'execute', handoffOf(null), 'ACCEPT'],
    ['execute/no-handoff', 'execute', undefined, 'ACCEPT'],
    ['execute/throwing', 'execute', throwing, 'CAPABILITY_UNAVAILABLE'],
    ['execute/pending', 'execute', pending, 'CAPABILITY_UNAVAILABLE'],
    ['execute/rejecting', 'execute', rejecting, 'CAPABILITY_UNAVAILABLE'],
    ['plan/active-lease', 'plan', handoffOf(executeLeaseSnapshot()), 'ACCEPT'],
    ['off/active-lease', 'off', handoffOf(executeLeaseSnapshot()), 'ACCEPT'],
    ['execute/unidentifiable-session', 'execute', handoffOf(executeLeaseSnapshot()), 'ACCEPT', agentOf({ header: {} })],
  ]

  // The command answers free text and the tool answers an envelope code; both
  // are classified by the stable code they expose, ACCEPT meaning the lease
  // gate let the request through to its ordinary target handling.
  const classify = (value) => {
    if (!value || value.kind !== 'error') return 'ACCEPT'
    if (value.text.includes('HANDOFF_ACTIVE_EXECUTE')) return 'HANDOFF_ACTIVE_EXECUTE'
    if (value.text.includes('CAPABILITY_UNAVAILABLE')) return 'CAPABILITY_UNAVAILABLE'
    return 'ACCEPT'
  }

  for (const [name, mode, handoff, expected, agent = agentOf()] of rows) {
    const definitions = []
    const ctx = {
      commands: { register(definition) { definitions.push(definition); return () => {} } },
      sessionProjections: { stateOf: (_session, key) => (key === 'ulwMode' ? { mode } : undefined) },
      workingDirectory: { get: () => '/tmp/ws' },
    }
    if (handoff !== undefined) ctx.handoff = handoff
    registerCommands(ctx)
    const review = definitions.find((definition) => definition.name === ULW_REVIEW_COMMAND)
    assert.ok(review, name + ' registered /ulw-review')
    const commandCode = classify(review.handler({ rawInput: 'not-a-plan.md', agent }))
    const gate = reviewLeaseGate(ctx, agent)
    const toolCode = gate === null ? 'ACCEPT' : gate.code
    assert.equal(commandCode, expected, name + ' command code')
    assert.equal(toolCode, expected, name + ' tool code')
    assert.equal(commandCode, toolCode, name + ' command/tool parity')
    if (mode !== 'execute') assert.deepEqual(handoff.calls, [], name + ' must not consult the execute lease')
  }
})

// ---------------------------------------------------------------------------
// ULW row 35: one shared lease predicate, lookup rejections contained
// ---------------------------------------------------------------------------

test('row 35: a rejecting async lease lookup escapes neither entry as an unhandled rejection', () => {
  const commandsUrl = new URL('../lib/commands.js', import.meta.url).href
  const toolsUrl = new URL('../lib/review-tools.js', import.meta.url).href
  // A child process is the only faithful probe: Node turns an unhandled
  // rejection into a non-zero exit, which an in-process assertion cannot show.
  const script = `
    import { registerCommands } from ${JSON.stringify(commandsUrl)}
    import { reviewLeaseGate } from ${JSON.stringify(toolsUrl)}

    const agent = { session: { id: 'session-1', header: { cwd: '/tmp/ws' } }, followup() {} }
    const handoff = {
      stateForSession() { return Promise.reject(new Error('handoff lease storage unavailable')) },
    }
    const definitions = []
    const ctx = {
      definitions,
      commands: { register(definition) { definitions.push(definition); return () => {} } },
      sessionProjections: { stateOf: (_session, key) => (key === 'ulwMode' ? { mode: 'execute' } : undefined) },
      workingDirectory: { get: () => '/tmp/ws' },
      handoff,
    }
    registerCommands(ctx)
    const review = definitions.find((definition) => definition.name === 'ulw-review')
    const command = review.handler({ rawInput: '.dsh/ulw/plans/demo.md', agent })
    const gate = reviewLeaseGate(ctx, agent)
    // Yield to the even loop so a rejected lookup would surface here, not later.
    await new Promise((resolve) => setTimeout(resolve, 100))
    process.stdout.write(JSON.stringify({
      commandKind: command.kind,
      commandText: command.text,
      gateCode: gate === null ? null : gate.code,
    }) + '\\n')
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 120000,
  })
  assert.equal(child.status, 0, 'the rejecting lookup must not kill the process; stderr: ' + child.stderr)
  assert.equal(/ERR_UNHANDLED_REJECTION|unhandledRejection/.test(child.stderr), false, child.stderr)
  const result = JSON.parse(child.stdout.trim().split('\n').pop())
  assert.equal(result.commandKind, 'error')
  assert.match(result.commandText, /CAPABILITY_UNAVAILABLE/)
  assert.equal(result.commandText.includes('HANDOFF_ACTIVE_EXECUTE'), false, 'a failed lookup is not a lease refusal')
  assert.equal(result.gateCode, 'CAPABILITY_UNAVAILABLE')
})
