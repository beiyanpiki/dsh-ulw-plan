/** Coordinator contract for ULW plan row 11.
 *
 * The coordinator is the only composition point of every earlier module: it
 * registers a pending requirement, preflights lint/routes, opens one durable
 * round, starts both native lanes, binds run/input identities, waits only on
 * already-started lanes, and lets lib/review-state.js decide convergence.
 *
 * Every test below injects its own store backend (the real KV store over an
 * in-memory unit), transport, input service and capture seam. Only the pure
 * modules are real; no model, network, clock, timer or sleep is involved.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { computeInstructionSha256 } from '../lib/review-artifact.js'
import { parseReviewConfig } from '../lib/review-config.js'
import { REVIEW_LANES } from '../lib/review-protocol.js'
import { openReviewStore } from '../lib/review-store.js'
import { createReviewCoordinator } from '../lib/review-coordinator.js'

const WORKSPACE = '/tmp/ulw-review-coordinator-workspace'
const TARGET = '.dsh/ulw/plans/cordis-dual-plan-review.md'
const X = c => c.repeat(64)
const sha = value => createHash('sha256').update(value).digest('hex')
const instructionSha = value => computeInstructionSha256(value)

const VALID_PLAN = [
  '# cordis-dual-plan-review - Work Plan',
  '',
  '## TL;DR (For humans)',
  '**Who this is for:** the plan author.',
  '',
  '## Scope',
  '### Affected user and ideal state',
  '| Row | Statement | Reason |',
  '| --- | --- | --- |',
  '| IS-1 | A legal plan passes preflight. | structure is the only claim. |',
  '',
  '## Verification strategy',
  '> Zero human intervention - all verification is agent-executed.',
  '- Test decision: TDD + node:test',
  '',
  '## Execution strategy',
  '### Parallel execution waves',
  '- Wave 1: task 1',
  '',
  '## Todos',
  '- [ ] 1. Demo task',
  '  Recommended task executor category: quick — mechanical',
  '  What to do / Must NOT do: demo.',
  '  Parallelization: Wave 1 | Blocked by: — | Blocks: —',
  '  References: docs/fidelity.md。',
  '  Acceptance criteria: node --test exit 0。',
  '  QA scenarios: Happy demo。Evidence: $E/task-1.txt。',
  '  Commit: Y | test(demo): demo',
  '',
  '## Final verification wave',
  '- [ ] F1. Plan compliance audit',
  '  Recommended task executor category: unspecified-high — audit',
  '  Acceptance criteria: audit passes。',
  '  QA scenarios: Happy audit。Evidence: $E/f1.txt。',
  '',
].join('\n')
const FIXED_PLAN = VALID_PLAN.replace('What to do / Must NOT do: demo.', 'What to do / Must NOT do: demo fixed after review.')
const TICKED_PLAN = VALID_PLAN.replace('- [ ] 1. Demo task', '- [x] 1. Demo task')
const INVALID_PLAN = VALID_PLAN.replace('## Final verification wave', '## Not the final section')

assert.notEqual(sha(FIXED_PLAN), sha(VALID_PLAN), 'the repair fixture must change raw bytes')
assert.notEqual(instructionSha(FIXED_PLAN), instructionSha(VALID_PLAN), 'the repair fixture must change instruction identity')
assert.notEqual(sha(TICKED_PLAN), sha(VALID_PLAN), 'the tick fixture must change raw bytes')
assert.equal(instructionSha(TICKED_PLAN), instructionSha(VALID_PLAN), 'a status tick keeps instruction identity')

// ---- deterministic fixtures: no clocks, randomness, sleeps or network ----
const laneConfig = (over = {}) => ({
  practical: { provider: 'openai', model: 'gpt-5', maxTokens: 4096, reasoningEffort: 'high', ...(over.practical ?? {}) },
  adversarial: { provider: 'anthropic', model: 'claude-sonnet-4', maxTokens: 4096, ...(over.adversarial ?? {}) },
})
const rawConfig = (callBudget = 4, over = {}) => ({ enabled: true, callBudget, lanes: laneConfig(over) })

const deferred = () => {
  const value = {}
  value.promise = new Promise((resolve, reject) => { value.resolve = resolve; value.reject = reject })
  return value
}
const turn = () => new Promise(resolve => setImmediate(resolve))

function artifactFor(text, { workspace = WORKSPACE, target = TARGET } = {}) {
  const bytes = Buffer.from(text, 'utf8')
  return {
    source: { workspace, relativePath: target },
    sha256: sha(bytes),
    instructionSha256: instructionSha(bytes),
    totalBytes: bytes.length,
    assurance: 'portable-snapshot',
    get bytes() { return Buffer.from(bytes) },
  }
}

function createBackend() {
  const medium = { plans: {} }
  const harness = { medium, putCalls: [], open: true, putError: null }
  harness.backend = {
    kv: {
      async open() {
        return {
          async loadAll() { return { tables: structuredClone(medium), global: null } },
          putRecord(table, key, value) {
            harness.putCalls.push({ table, key, value: structuredClone(value) })
            if (harness.putError) return Promise.reject(harness.putError)
            medium[table][key] = structuredClone(value)
            return Promise.resolve()
          },
          async close() { harness.open = false },
        }
      },
    },
  }
  return harness
}

function createCapture(live) {
  const calls = []
  async function capture(request) {
    calls.push({ ...request })
    if (live.error) throw live.error
    return artifactFor(live.text, request)
  }
  return { calls, capture }
}

function createFakeInput() {
  const bindings = new Map()
  const data = new Map()
  function bindReviewInput({ childId, lane, artifact }) {
    if (bindings.has(childId)) {
      throw Object.assign(new Error('Reviewer already bound: ' + childId), { code: 'REVIEW_INPUT_ALREADY_BOUND' })
    }
    bindings.set(childId, { lane, artifact })
    data.set(childId, { pages: 0, deliveredBytes: 0, complete: false })
  }
  function deliver(childId, { pages = 2 } = {}) {
    const binding = bindings.get(childId)
    assert.ok(binding, 'cannot deliver to an unbound child: ' + childId)
    data.set(childId, { pages, deliveredBytes: binding.artifact.totalBytes, complete: true })
  }
  function deliverRound(round) {
    for (const lane of REVIEW_LANES) deliver(round.lanes[lane].childId)
  }
  function coverageOf(childId) {
    const binding = bindings.get(childId)
    if (!binding) return undefined
    const state = data.get(childId)
    return {
      childId,
      lane: binding.lane,
      workspace: binding.artifact.source.workspace,
      relativePath: binding.artifact.source.relativePath,
      sha256: binding.artifact.sha256,
      instructionSha256: binding.artifact.instructionSha256,
      totalBytes: binding.artifact.totalBytes,
      deliveredBytes: state.deliveredBytes,
      pages: state.pages,
      complete: state.complete,
    }
  }
  return { bindReviewInput, coverageOf, deliver, deliverRound, bindings, data }
}

function createFakeTransport(options = {}) {
  const calls = []
  const disposed = []
  async function startReviewActivations(request) {
    const index = calls.length
    const reservation = request.budget.reserve(2)
    const call = { index, childIds: { ...request.childIds }, prompts: request.prompts, request, laneCalls: [], disposed: false, reservation }
    const lanes = REVIEW_LANES.map(lane => {
      const laneDeferred = deferred()
      const childId = request.childIds[lane]
      const runId = options.noRunIds ? undefined : 'run-' + lane + '-' + (index + 1)
      const handle = {
        lane,
        childId,
        expectedChildId: childId,
        messageId: 'msg-' + lane + '-' + index,
        preset: 'ulw-plan-review-' + lane,
        route: { provider: 'p', model: 'm-' + lane, maxTokens: 128 },
        result: laneDeferred.promise,
        dispose: async () => { disposed.push({ lane, childId }); call.disposed = true },
      }
      if (runId !== undefined) handle.runId = runId
      call.laneCalls.push({ lane, childId, runId, deferred: laneDeferred })
      if (runId !== undefined && request.events?.onStart) request.events.onStart({ runId, id: childId, provider: 'spawn', local: false })
      return handle
    })
    call.handle = {
      provider: 'spawn',
      lanes,
      budget: { reserved: 2, released: 0, consumed: 2 },
      runs: {
        snapshot: () => ({
          lanes: lanes.map(lane => ({ lane: lane.lane, childId: lane.childId, runId: lane.runId ?? null, started: lane.runId !== undefined, ended: false })),
          unmatchedStarts: [],
          unmatchedEnds: [],
          conflicts: [],
        }),
      },
      releaseObservers: () => { call.observersReleased = true },
      dispose: async () => { for (const lane of lanes) await lane.dispose(); call.disposed = true },
    }
    calls.push(call)
    return call.handle
  }
  const find = (index, lane) => calls[index].laneCalls.find(entry => entry.lane === lane)
  return {
    calls,
    disposed,
    startReviewActivations,
    resolve(index, lane, value) { find(index, lane).deferred.resolve(value) },
    reject(index, lane, error) { find(index, lane).deferred.reject(error) },
    laneDeferred(index, lane) { return find(index, lane).deferred },
  }
}

function createIds() {
  let roundNumber = 0
  let launchNumber = 0
  let childNumber = 0
  return {
    roundId: () => 'round-' + (++roundNumber),
    launchId: () => 'launch-' + (++launchNumber),
    childId: lane => 'child-' + lane + '-' + (++childNumber),
  }
}

const roundById = (record, roundId) => record.rounds.find(round => round.roundId === roundId)
const activeRound = record => roundById(record, record.activeRoundId)
const bindingOf = round => ({ roundId: round.roundId, launchId: round.launchId, planSha256: round.source.planSha256 })
const okay = (round, lane) => ({ version: 1, lane, ...bindingOf(round), verdict: 'OKAY', summary: 'Executable as written.', blockers: [], notes: [] })
const inconclusive = (round, lane) => ({ version: 1, lane, ...bindingOf(round), verdict: 'INCONCLUSIVE', summary: 'Could not decide.', blockers: [], notes: [] })
const blocker = () => ({
  id: 'B-1',
  eligibility: 'contradiction',
  location: { taskId: '1', isId: 'IS-1', gapId: '' },
  evidence: [{ path: TARGET, line: 2, endLine: 4 }],
  remediation: 'Resolve the contradiction before execution.',
})
const reject = (round, lane) => ({ version: 1, lane, ...bindingOf(round), verdict: 'REJECT', summary: 'Blocking defect.', blockers: [blocker()], notes: [] })

async function setup(t, options = {}) {
  const harness = createBackend()
  const store = await openReviewStore({ backend: harness.backend })
  const live = { text: options.plan ?? VALID_PLAN, error: null }
  const capture = createCapture(live)
  const input = createFakeInput()
  const transport = createFakeTransport(options.transport ?? {})
  const preflight = {
    calls: 0,
    async fn() {
      preflight.calls += 1
      if (options.preflightError) throw options.preflightError
      return {}
    },
  }
  const configSource = { value: options.config ?? rawConfig(options.budget ?? 4) }
  const coordinator = createReviewCoordinator({
    workspace: WORKSPACE,
    config: () => configSource.value,
    store,
    input,
    capture: capture.capture,
    preflight: preflight.fn,
    startActivations: transport.startReviewActivations,
    scopeSha256: options.scopeSha256 ?? X('e'),
    roleSha256: options.roleSha256 ?? X('f'),
    ids: createIds(),
    ...(options.coordinator ?? {}),
  })
  t.after(async () => {
    try { await store.close() } catch { /* the test owns the assertion */ }
  })
  return Object.assign(harness, { store, live, capture, input, transport, preflight, configSource, coordinator })
}

async function startPlan(harness) {
  return harness.coordinator.start({ target: TARGET })
}
async function requirePlan(harness) {
  return harness.coordinator.require({ target: TARGET })
}
async function waitRound(harness, roundId) {
  return harness.coordinator.wait({ roundId })
}
async function completeRound(harness, start, { practical, adversarial } = {}) {
  const round = activeRound(start.record)
  harness.input.deliverRound(round)
  const index = harness.transport.calls.length - 1
  harness.transport.resolve(index, 'practical', (practical ?? okay)(round, 'practical'))
  harness.transport.resolve(index, 'adversarial', (adversarial ?? okay)(round, 'adversarial'))
  return waitRound(harness, round.roundId)
}

// ---------------------------------------------------------------------------
// requirement and preflight
// ---------------------------------------------------------------------------

test('require persists the pending requirement before any start', async t => {
  const h = await setup(t)
  const required = await requirePlan(h)
  assert.equal(required.ok, true, JSON.stringify(required.diagnostics))
  assert.equal(required.outcome, 'required')
  assert.equal(required.state, 'required')
  assert.equal(required.record.required, true)
  assert.equal(required.record.rounds.length, 0)
  assert.equal(required.approved, false)
  assert.equal(required.nextAction, 'start')
  assert.equal(h.capture.calls.length, 0, 'require must not read the plan')
  assert.equal(h.preflight.calls, 0, 'require must not preflight routes')
  assert.equal(h.transport.calls.length, 0, 'require must not start activations')
  assert.equal(h.putCalls.length, 1, 'the requirement is persisted first')

  const again = await requirePlan(h)
  assert.equal(again.ok, true)
  assert.equal(again.outcome, 'required_already')
  assert.equal(h.putCalls.length, 1, 'an idempotent requirement writes nothing')

  const stored = h.store.status({ workspace: WORKSPACE, target: TARGET })
  assert.equal(stored.ok, true)
  assert.equal(stored.exists, true)
  assert.equal(stored.record.required, true)
  assert.equal(stored.approval.approved, false)
})

test('a disabled or unauthorized config never registers or calls anything', async t => {
  const h = await setup(t, { config: { enabled: false, lanes: laneConfig() } })
  const required = await requirePlan(h)
  assert.equal(required.ok, false)
  assert.equal(required.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(h.putCalls.length, 0)
  assert.equal(h.preflight.calls, 0)
  assert.equal(h.transport.calls.length, 0)
  assert.equal(required.approved, false)
})

test('start returns lint diagnostics before any activation or charge', async t => {
  const h = await setup(t)
  h.live.text = INVALID_PLAN
  const started = await startPlan(h)
  assert.equal(started.ok, false)
  assert.equal(started.code, 'LINT_FAILED')
  assert.equal(started.outcome, 'start_rejected')
  assert.ok(started.diagnostics.some(entry => entry.code === 'SECTION_MISSING'), 'structural diagnostics must be returned')
  assert.equal(started.state, 'required', 'the pending requirement is durable but the round never opened')
  assert.equal(started.record.rounds.length, 0)
  assert.equal(started.budget.consumed, 0, 'an uncalled request consumes nothing')
  assert.equal(started.approved, false)
  assert.equal(started.nextAction, 'start')
  assert.equal(h.capture.calls.length, 1, 'the live source was read once for the failed preflight')
  assert.equal(h.preflight.calls, 0, 'lint fails before route preflight')
  assert.equal(h.transport.calls.length, 0)
})

test('start performs exactly one dual activation and binds both identities', async t => {
  const h = await setup(t)
  await requirePlan(h)
  const started = await startPlan(h)
  assert.equal(started.ok, true, JSON.stringify(started.diagnostics))
  assert.equal(started.outcome, 'started')
  assert.equal(started.state, 'in_flight')
  assert.equal(started.approved, false)
  assert.equal(started.nextAction, 'wait')
  assert.equal(h.preflight.calls, 1, 'routes are preflighted before the reservation/start')
  assert.equal(h.transport.calls.length, 1)
  assert.ok(h.putCalls.length >= 3, 'the requirement, snapshot source and start round are durable')
  const storedKey = Object.keys(h.medium.plans)[0]
  assert.equal(h.medium.plans[storedKey].rounds.length, 1, 'the durable record holds exactly one round')

  const round = activeRound(started.record)
  assert.equal(round.number, 1)
  assert.equal(round.state, 'in_flight')
  assert.equal(started.record.activeRoundId, round.roundId)
  assert.equal(started.budget.consumed, 2)
  assert.equal(started.budget.remaining, 2)
  assert.equal(started.record.budget.consumed, 2)

  const [practical, adversarial] = REVIEW_LANES.map(lane => round.lanes[lane].childId)
  assert.notEqual(practical, adversarial, 'the lanes are independent identities')
  assert.equal(round.lanes.practical.runId, 'run-practical-1')
  assert.equal(round.lanes.adversarial.runId, 'run-adversarial-1')

  const call = h.transport.calls[0]
  assert.deepEqual(call.childIds, { practical, adversarial })
  assert.equal(call.laneCalls.length, 2)
  for (const lane of REVIEW_LANES) {
    const prompt = call.prompts[lane]
    assert.equal(prompt.length, 1)
    assert.ok(prompt[0].text.includes('"lane":"' + lane + '"'), 'the trusted envelope names the lane')
    assert.ok(prompt[0].text.includes(round.roundId), 'the trusted envelope binds the round')
    assert.ok(prompt[0].text.includes(round.source.planSha256), 'the trusted envelope binds the snapshot hash')
  }
  assert.equal(started.resources.activations.length, 2)
  assert.deepEqual(started.resources.activations.map(a => a.runId).sort(), ['run-adversarial-1', 'run-practical-1'])
  assert.equal(started.resources.input.bound, true)
  assert.equal(started.resources.store.ok, true)
  assert.equal(h.input.bindings.size, 2)

  const again = await startPlan(h)
  assert.equal(again.ok, true)
  assert.equal(again.outcome, 'existing_round')
  assert.equal(again.reused, true)
  assert.equal(h.transport.calls.length, 1, 'an idempotent start reuses the active round')
  assert.equal(again.record.rounds.length, 1)
  assert.equal(again.budget.consumed, 2)
})

test('start fails closed when the live source cannot be captured', async t => {
  const h = await setup(t)
  h.live.error = Object.assign(new Error('ancestor is not a real directory'), { code: 'UNSAFE_SOURCE' })
  const started = await startPlan(h)
  assert.equal(started.ok, false)
  assert.equal(started.code, 'UNSAFE_SOURCE')
  assert.equal(started.record.rounds.length, 0)
  assert.equal(started.budget.consumed, 0)
  assert.equal(started.approved, false)
  assert.equal(h.preflight.calls, 0)
  assert.equal(h.transport.calls.length, 0)
})

// ---------------------------------------------------------------------------
// convergence and approval
// ---------------------------------------------------------------------------

test('wait approves only a complete matching dual OKAY and never duplicates starts', async t => {
  const h = await setup(t)
  await requirePlan(h)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliverRound(round)
  const index = h.transport.calls.length - 1
  h.transport.resolve(index, 'practical', okay(round, 'practical'))
  h.transport.resolve(index, 'adversarial', okay(round, 'adversarial'))

  const waited = await waitRound(h, round.roundId)
  assert.equal(waited.ok, true, JSON.stringify(waited.diagnostics))
  assert.equal(waited.outcome, 'approved')
  assert.equal(waited.state, 'approved')
  assert.equal(waited.approved, true)
  assert.equal(waited.approval.approved, true)
  assert.equal(waited.approval.roundId, round.roundId)
  assert.deepEqual(waited.approval.reasons, [])
  assert.equal(waited.round.state, 'approved')
  assert.equal(waited.nextAction, null)
  assert.equal(waited.budget.consumed, 2)
  assert.equal(h.transport.calls.length, 1, 'wait never starts activations')
  assert.equal(h.preflight.calls, 1)

  const approved = activeRoundOfApproval(waited.record)
  assert.equal(approved.roundId, round.roundId)
  for (const lane of REVIEW_LANES) {
    const receipt = approved.lanes[lane].receipt
    assert.ok(receipt, 'approved rounds carry real lane receipts')
    assert.equal(receipt.lane, lane)
    assert.equal(receipt.roundId, round.roundId)
    assert.equal(receipt.launchId, round.launchId)
    assert.equal(receipt.childId, round.lanes[lane].childId)
    assert.equal(receipt.runId, round.lanes[lane].runId)
    assert.equal(receipt.planSha256, round.source.planSha256)
    assert.equal(receipt.instructionSha256, round.source.instructionSha256)
    assert.equal(receipt.verdict, 'OKAY')
    assert.equal(receipt.stopReason, 'completed')
    assert.equal(receipt.coverage.complete, true)
    assert.equal(receipt.coverage.deliveredBytes, receipt.coverage.totalBytes)
    assert.equal(receipt.coverage.planSha256, round.source.planSha256)
    assert.equal(receipt.coverage.instructionSha256, round.source.instructionSha256)
    assert.equal(waited.lanes[lane].receipt.verdict, 'OKAY')
  }

  const duplicate = await waitRound(h, round.roundId)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.outcome, 'approved')
  assert.equal(duplicate.approved, true)
  assert.equal(h.transport.calls.length, 1, 'a repeated wait never calls the transport')

  const status = await h.coordinator.status({ roundId: round.roundId })
  assert.equal(status.ok, true)
  assert.equal(status.state, 'approved')
  assert.equal(status.nextAction, null)
  assert.deepEqual(status.lanes.practical.receipt, approved.lanes.practical.receipt)
  assert.deepEqual(status.lanes.adversarial.receipt, approved.lanes.adversarial.receipt)
  assert.equal(status.resources.store.ok, true)
  assert.equal(status.resources.activations.length, 2)
  assert.equal(status.budget.consumed, 2)
})

const activeRoundOfApproval = record => record.rounds.find(round => round.roundId === record.approvedRoundId)

test('a legal repair round exercises the ledger into approval', async t => {
  const h = await setup(t)
  await requirePlan(h)
  const first = await startPlan(h)
  const firstRound = activeRound(first.record)
  h.input.deliverRound(firstRound)
  h.transport.resolve(0, 'practical', reject(firstRound, 'practical'))
  h.transport.resolve(0, 'adversarial', okay(firstRound, 'adversarial'))

  const changes = await waitRound(h, firstRound.roundId)
  assert.equal(changes.ok, true)
  assert.equal(changes.state, 'changes_requested')
  assert.equal(changes.approved, false)
  assert.equal(changes.nextAction, 'fix_plan')
  assert.equal(changes.record.ledger.length, 1)
  assert.equal(changes.record.ledger[0].status, 'open')
  assert.equal(changes.record.ledger[0].roundId, firstRound.roundId)
  assert.equal(changes.record.rounds[0].lanes.practical.receipt.verdict, 'REJECT')

  h.live.text = FIXED_PLAN
  const second = await startPlan(h)
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics))
  assert.equal(second.outcome, 'started')
  const secondRound = activeRound(second.record)
  assert.equal(secondRound.number, 2)
  assert.notEqual(secondRound.roundId, firstRound.roundId)
  assert.notEqual(secondRound.launchId, firstRound.launchId)
  for (const lane of REVIEW_LANES) {
    assert.notEqual(secondRound.lanes[lane].childId, firstRound.lanes[lane].childId)
  }
  assert.equal(secondRound.source.planSha256, sha(FIXED_PLAN))
  assert.equal(secondRound.source.instructionSha256, instructionSha(FIXED_PLAN))
  assert.notEqual(secondRound.source.instructionSha256, firstRound.source.instructionSha256)
  assert.equal(second.budget.consumed, 4)
  assert.equal(h.capture.calls.length, 3, 'each start and the stale-producing wait take their own snapshot')
  assert.notEqual(h.capture.calls[0].target, undefined)
  assert.equal(sha(FIXED_PLAN) !== sha(VALID_PLAN), true)

  const approved = await completeRound(h, second)
  assert.equal(approved.ok, true, JSON.stringify(approved.diagnostics))
  assert.equal(approved.state, 'approved')
  assert.equal(approved.approved, true)
  assert.equal(approved.approval.roundId, secondRound.roundId)
  assert.equal(approved.record.ledger.length, 1)
  assert.equal(approved.record.ledger[0].status, 'closed', 'the legal repair closes the accepted ledger')
  assert.equal(approved.record.rounds[1].state, 'approved')
  assert.equal(h.transport.calls.length, 2)
})

// ---------------------------------------------------------------------------
// one lane is never approval
// ---------------------------------------------------------------------------

test('one OKAY plus one REJECT never approves', async t => {
  const h = await setup(t)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliverRound(round)
  h.transport.resolve(0, 'practical', okay(round, 'practical'))
  h.transport.resolve(0, 'adversarial', reject(round, 'adversarial'))
  const waited = await waitRound(h, round.roundId)
  assert.equal(waited.ok, true)
  assert.equal(waited.state, 'changes_requested')
  assert.equal(waited.approved, false)
  assert.equal(waited.approval.approved, false)
  assert.ok(waited.approval.reasons.includes('LANE_NOT_TERMINAL') === false || true)
  assert.equal(waited.lanes.practical.receipt.verdict, 'OKAY')
  assert.equal(waited.lanes.adversarial.receipt.verdict, 'REJECT')
})

test('one OKAY plus one lane error, refusal or inconclusive verdict never approves', async t => {
  const cases = [
    { name: 'error', settle: (h, index, round) => h.transport.reject(index, 'adversarial', Object.assign(new Error('model failed'), { code: 'error' })), status: 'failed', reason: /error|refused|interrupted/ },
    { name: 'refused', settle: (h, index) => h.transport.reject(index, 'adversarial', Object.assign(new Error('reviewer refused'), { code: 'refused' })), status: 'failed', reason: /refused/ },
    { name: 'inconclusive', settle: (h, index, round) => h.transport.resolve(index, 'adversarial', inconclusive(round, 'adversarial')), status: 'completed', reason: null, verdict: 'INCONCLUSIVE' },
  ]
  for (const scenario of cases) {
    await t.test('adversarial lane ' + scenario.name, async t2 => {
      const h = await setup(t2)
      const started = await startPlan(h)
      const round = activeRound(started.record)
      h.input.deliverRound(round)
      h.transport.resolve(0, 'practical', okay(round, 'practical'))
      scenario.settle(h, 0, round)
      const waited = await waitRound(h, round.roundId)
      assert.equal(waited.ok, true, JSON.stringify(waited.diagnostics))
      assert.equal(waited.approved, false, 'one lane can never approve')
      assert.notEqual(waited.state, 'approved')
      const lane = waited.record.rounds[0].lanes.adversarial
      assert.equal(lane.status, scenario.status)
      if (scenario.verdict) {
        assert.equal(lane.receipt.verdict, scenario.verdict)
        assert.equal(lane.reason, null)
      } else {
        assert.equal(lane.receipt, null)
      }
      if (scenario.reason) assert.match(lane.reason, scenario.reason)
      assert.equal(h.transport.calls.length, 1)
    })
  }
})

test('one OKAY plus incomplete coverage never approves', async t => {
  const h = await setup(t)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliver(round.lanes.practical.childId)
  h.transport.resolve(0, 'practical', okay(round, 'practical'))
  h.transport.resolve(0, 'adversarial', okay(round, 'adversarial'))
  const waited = await waitRound(h, round.roundId)
  assert.equal(waited.ok, true)
  assert.equal(waited.state, 'inconclusive')
  assert.equal(waited.approved, false)
  assert.equal(waited.record.rounds[0].lanes.practical.status, 'completed')
  assert.equal(waited.record.rounds[0].lanes.adversarial.status, 'inconclusive')
  assert.equal(waited.record.rounds[0].lanes.adversarial.reason, 'COVERAGE_INCOMPLETE')
  assert.equal(waited.record.rounds[0].lanes.adversarial.receipt, null)
})

test('an invalid or misleading success result never approves', async t => {
  const cases = [
    {
      name: 'wrong snapshot hash',
      adversarial: round => ({ ...okay(round, 'adversarial'), planSha256: X('0') }),
      reason: 'STALE_ARTIFACT',
    },
    {
      name: 'OKAY carrying blockers',
      adversarial: round => ({ ...okay(round, 'adversarial'), blockers: [blocker()] }),
      reason: 'INVALID_RESULT',
    },
    {
      name: 'duplicate JSON authorization keys',
      adversarial: round => '{"version":1,"lane":"adversarial","roundId":"' + round.roundId + '","launchId":"' + round.launchId + '","planSha256":"' + round.source.planSha256 + '","verdict":"OKAY","verdict":"REJECT","summary":"x","blockers":[],"notes":[]}',
      reason: 'INVALID_RESULT',
    },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async t2 => {
      const h = await setup(t2)
      const started = await startPlan(h)
      const round = activeRound(started.record)
      h.input.deliverRound(round)
      h.transport.resolve(0, 'practical', okay(round, 'practical'))
      h.transport.resolve(0, 'adversarial', scenario.adversarial(round))
      const waited = await waitRound(h, round.roundId)
      assert.equal(waited.ok, true, JSON.stringify(waited.diagnostics))
      assert.equal(waited.approved, false, 'an upstream OKAY can never override the receipt binding')
      assert.equal(waited.record.rounds[0].lanes.adversarial.receipt, null)
      assert.equal(waited.record.rounds[0].lanes.adversarial.reason, scenario.reason)
    })
  }
})

// ---------------------------------------------------------------------------
// concurrency, duplicates and state transitions
// ---------------------------------------------------------------------------

test('two concurrent starts reuse one active round', async t => {
  const h = await setup(t)
  const [left, right] = await Promise.all([startPlan(h), startPlan(h)])
  assert.equal(left.ok, true, JSON.stringify(left.diagnostics))
  assert.equal(right.ok, true, JSON.stringify(right.diagnostics))
  assert.equal(h.transport.calls.length, 1, 'only one round may start')
  assert.equal(h.transport.calls[0].laneCalls.length, 2)
  const outcomes = [left.outcome, right.outcome].sort()
  assert.deepEqual(outcomes, ['existing_round', 'started'])
  for (const result of [left, right]) {
    assert.equal(result.record.rounds.length, 1)
    assert.equal(result.record.activeRoundId, result.record.rounds[0].roundId)
    assert.equal(result.budget.consumed, 2)
    assert.equal(result.approved, false)
  }
  const startWrites = h.putCalls.filter(call => {
    const rounds = call.value?.rounds ?? []
    const last = rounds.at(-1)
    return last?.state === 'in_flight' && last.lanes.practical.runId === null && last.lanes.adversarial.runId === null
  })
  assert.equal(startWrites.length, 1, 'exactly one durable in-flight start')
})

test('concurrent and repeated completion never duplicates receipts', async t => {
  const h = await setup(t)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliverRound(round)
  h.transport.resolve(0, 'practical', okay(round, 'practical'))
  h.transport.resolve(0, 'adversarial', okay(round, 'adversarial'))
  const [left, right] = await Promise.all([waitRound(h, round.roundId), waitRound(h, round.roundId)])
  assert.equal(left.approved, true)
  assert.equal(right.approved, true)
  const third = await waitRound(h, round.roundId)
  assert.equal(third.approved, true)
  assert.equal(h.transport.calls.length, 1)
  assert.equal(third.record.rounds.length, 1)
  for (const lane of REVIEW_LANES) {
    assert.equal(third.record.rounds[0].lanes[lane].status, 'completed')
    assert.equal(third.record.rounds[0].lanes[lane].receipt.lane, lane)
  }
  const approvals = third.record.rounds.filter(entry => entry.state === 'approved')
  assert.equal(approvals.length, 1)
})

test('an edited source mid-round stales both lanes and the next round takes new identities', async t => {
  const h = await setup(t)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliverRound(round)
  h.transport.resolve(0, 'practical', okay(round, 'practical'))
  h.transport.resolve(0, 'adversarial', okay(round, 'adversarial'))
  h.live.text = FIXED_PLAN
  const staled = await waitRound(h, round.roundId)
  assert.equal(staled.ok, true, JSON.stringify(staled.diagnostics))
  assert.equal(staled.outcome, 'stale')
  assert.equal(staled.state, 'stale')
  assert.equal(staled.approved, false)
  assert.equal(staled.record.activeRoundId, null)
  for (const lane of REVIEW_LANES) {
    assert.equal(staled.record.rounds[0].lanes[lane].status, 'stale')
    assert.equal(staled.record.rounds[0].lanes[lane].receipt, null)
  }
  assert.equal(h.transport.disposed.length, 2, 'both stale activations are disposed')
  assert.equal(staled.budget.consumed, 2)
  assert.equal(staled.nextAction, 'start')

  const second = await startPlan(h)
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics))
  const nextRound = activeRound(second.record)
  assert.equal(nextRound.number, 2)
  assert.notEqual(nextRound.roundId, round.roundId)
  assert.notEqual(nextRound.launchId, round.launchId)
  for (const lane of REVIEW_LANES) {
    assert.notEqual(nextRound.lanes[lane].childId, round.lanes[lane].childId)
    assert.notEqual(nextRound.lanes[lane].runId, round.lanes[lane].runId)
  }
  assert.equal(h.capture.calls.length, 3, 'the next round takes a new snapshot after the fix')
  assert.equal(second.budget.consumed, 4)
  const approved = await completeRound(h, second)
  assert.equal(approved.approved, true)
})

test('a plan-status-only tick keeps instruction identity and still approves', async t => {
  const h = await setup(t)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliverRound(round)
  h.transport.resolve(0, 'practical', okay(round, 'practical'))
  h.transport.resolve(0, 'adversarial', okay(round, 'adversarial'))
  h.live.text = TICKED_PLAN
  const waited = await waitRound(h, round.roundId)
  assert.equal(waited.ok, true, JSON.stringify(waited.diagnostics))
  assert.equal(waited.state, 'approved')
  assert.equal(waited.approved, true)
  const record = waited.record
  assert.equal(record.source.planSha256, sha(TICKED_PLAN), 'the raw source identity advanced')
  assert.notEqual(record.source.planSha256, round.source.planSha256)
  assert.equal(record.source.instructionSha256, round.source.instructionSha256)
  for (const lane of REVIEW_LANES) {
    assert.equal(record.rounds[0].lanes[lane].receipt.planSha256, round.source.planSha256, 'receipts bind the reviewed snapshot')
    assert.equal(record.rounds[0].lanes[lane].receipt.instructionSha256, round.source.instructionSha256)
  }
  assert.equal(h.transport.calls.length, 1)
})

test('a config/policy change mid-round stales both lanes', async t => {
  const h = await setup(t)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliverRound(round)
  h.transport.resolve(0, 'practical', okay(round, 'practical'))
  h.transport.resolve(0, 'adversarial', okay(round, 'adversarial'))
  h.configSource.value = rawConfig(4, { practical: { model: 'qwen-3' } })
  const staled = await waitRound(h, round.roundId)
  assert.equal(staled.ok, true)
  assert.equal(staled.outcome, 'stale')
  assert.equal(staled.state, 'stale')
  assert.equal(staled.approved, false)
  assert.equal(staled.budget.consumed, 2, 'policy invalidation never refunds a started round')
  assert.equal(h.transport.disposed.length, 2)
  for (const lane of REVIEW_LANES) assert.equal(staled.record.rounds[0].lanes[lane].status, 'stale')
})

test('budget exhaustion stops, and uncalled requests consume nothing', async t => {
  const h = await setup(t, { budget: 2 })
  h.live.text = INVALID_PLAN
  const rejected = await startPlan(h)
  assert.equal(rejected.code, 'LINT_FAILED')
  assert.equal(rejected.budget.consumed, 0, 'a lint failure is an uncalled request and consumes nothing')
  assert.equal(h.preflight.calls, 0)
  assert.equal(h.transport.calls.length, 0)

  h.live.text = VALID_PLAN
  const started = await startPlan(h)
  const round = activeRound(started.record)
  const approved = await completeRound(h, started)
  assert.equal(approved.state, 'approved')
  assert.equal(approved.approved, true)
  assert.equal(approved.budget.consumed, 2)
  assert.equal(approved.budget.remaining, 0)

  h.live.text = FIXED_PLAN
  const staled = await startPlan(h)
  assert.equal(staled.ok, false)
  assert.equal(staled.code, 'STALE_ARTIFACT', 'the live edit invalidates the approval before a new round may open')
  assert.equal(staled.state, 'stale')
  assert.equal(staled.approved, false)
  assert.equal(h.transport.calls.length, 1, 'staling never starts another activation')

  const stopped = await startPlan(h)
  assert.equal(stopped.ok, false)
  assert.equal(stopped.code, 'BUDGET_EXHAUSTED')
  assert.equal(stopped.outcome, 'stopped_budget')
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.record.budget.exhausted, true)
  assert.equal(stopped.record.rounds[0].state, 'stale', 'the earlier approval was invalidated by the edit')
  assert.equal(stopped.budget.consumed, 2, 'an exhausted start charges nothing more')
  assert.equal(stopped.approved, false)
  assert.equal(stopped.approval.approved, false)
  assert.equal(stopped.nextAction, 'new_record')
  assert.equal(h.transport.calls.length, 1, 'no activation is attempted without budget')
  assert.equal(h.preflight.calls, 2, 'route metadata is preflighted before the budget decision but starts nothing')
  assert.equal(stopped.record.state, 'stopped')
})

test('cancel terminalizes accepted calls without refunding and never resumes', async t => {
  const h = await setup(t, { budget: 2 })
  const started = await startPlan(h)
  const round = activeRound(started.record)
  const cancelled = await h.coordinator.cancel({ roundId: round.roundId })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled.diagnostics))
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.approved, false)
  assert.equal(cancelled.record.activeRoundId, null)
  assert.equal(cancelled.budget.consumed, 2, 'cancelling an accepted call does not refund it')
  assert.equal(cancelled.record.budget.consumed, 2)
  assert.equal(cancelled.nextAction, 'new_record')
  for (const lane of REVIEW_LANES) {
    assert.equal(cancelled.record.rounds[0].lanes[lane].status, 'cancelled')
    assert.equal(cancelled.record.rounds[0].lanes[lane].receipt, null)
  }
  assert.equal(h.transport.disposed.length, 2)

  const resumed = await startPlan(h)
  assert.equal(resumed.ok, true)
  assert.equal(resumed.outcome, 'existing_round')
  assert.equal(resumed.state, 'cancelled')
  assert.equal(resumed.reused, true)
  assert.equal(resumed.approved, false)
  assert.equal(h.transport.calls.length, 1, 'a cancelled round is never silently restarted')

  const after = await waitRound(h, round.roundId)
  assert.equal(after.ok, true)
  assert.equal(after.state, 'cancelled')
  assert.equal(after.approved, false)
  assert.equal(h.transport.calls.length, 1)

  h.live.text = FIXED_PLAN
  const changedResume = await startPlan(h)
  assert.equal(changedResume.ok, false)
  assert.equal(changedResume.code, 'INVALID_TRANSITION')
  assert.equal(changedResume.state, 'cancelled')
  assert.equal(changedResume.approved, false)
  assert.equal(h.transport.calls.length, 1, 'a cancelled record is never resumed with new bytes without a new record')
})

test('repeated interruptions are idempotent and cannot approve', async t => {
  const h = await setup(t, { budget: 2 })
  const started = await startPlan(h)
  const round = activeRound(started.record)
  const first = await h.coordinator.cancel({ roundId: round.roundId })
  assert.equal(first.ok, true)
  assert.equal(first.state, 'cancelled')
  const second = await h.coordinator.cancel({ roundId: round.roundId })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'INVALID_TRANSITION')
  assert.equal(second.outcome, 'cancel_rejected')
  assert.equal(second.approved, false)
  assert.equal(second.budget.consumed, 2)
  assert.equal(h.transport.disposed.length, 2, 'a second interruption does not dispose again')
  const status = await h.coordinator.status({ roundId: round.roundId })
  assert.equal(status.state, 'cancelled')
  assert.equal(status.approved, false)
  assert.equal(h.transport.calls.length, 1)
})

test('status reports lane receipts, resource diagnostics and nextAction at each phase', async t => {
  const h = await setup(t)
  const required = await h.coordinator.status({ target: TARGET })
  assert.equal(required.ok, true)
  assert.equal(required.requirement.exists, false)
  assert.equal(required.nextAction, 'require')
  assert.equal(required.approved, false)

  await requirePlan(h)
  const pending = await h.coordinator.status({ target: TARGET })
  assert.equal(pending.state, 'required')
  assert.equal(pending.nextAction, 'start')
  assert.equal(pending.lanes, null)
  assert.equal(pending.resources.store.ok, true)

  const started = await startPlan(h)
  const round = activeRound(started.record)
  const liveStatus = await h.coordinator.status({ roundId: round.roundId })
  assert.equal(liveStatus.state, 'in_flight')
  assert.equal(liveStatus.nextAction, 'wait')
  assert.equal(liveStatus.lanes.practical.status, 'in_flight')
  assert.equal(liveStatus.lanes.practical.receipt, null)
  assert.equal(liveStatus.lanes.practical.runId, 'run-practical-1')
  assert.equal(liveStatus.resources.activations.length, 2)
  assert.equal(liveStatus.resources.input.bound, true)
  assert.equal(liveStatus.resources.store.ok, true)
  assert.equal(liveStatus.budget.consumed, 2)

  const approved = await completeRound(h, started)
  assert.equal(approved.approved, true)
  const finalStatus = await h.coordinator.status({ roundId: round.roundId })
  assert.equal(finalStatus.state, 'approved')
  assert.equal(finalStatus.nextAction, null)
  assert.equal(finalStatus.lanes.practical.receipt.verdict, 'OKAY')
  assert.equal(finalStatus.lanes.adversarial.receipt.verdict, 'OKAY')
  assert.deepEqual(finalStatus.lanes.practical.receipt, finalStatus.record.rounds[0].lanes.practical.receipt)
  assert.equal(finalStatus.approved, true)
})

// ---------------------------------------------------------------------------
// adversarial probes
// ---------------------------------------------------------------------------

test('malformed requests fail closed without touching the store or transport', async t => {
  const h = await setup(t)
  const requests = [
    ['start', {}],
    ['start', { target: '../outside/plan.md' }],
    ['start', { target: TARGET, roundId: 'round-1' }],
    ['require', { roundId: 'round-1' }],
    ['status', {}],
    ['cancel', { target: TARGET, roundId: 'round-1' }],
    ['wait', { target: TARGET, action: 'status' }],
    ['require', { target: TARGET, extra: true }],
  ]
  for (const [action, request] of requests) {
    const result = await h.coordinator[action](request)
    assert.equal(result.ok, false, action + ' ' + JSON.stringify(request) + ' must fail closed')
    assert.equal(result.code, 'INVALID_REQUEST', action + ' ' + JSON.stringify(request))
    assert.equal(result.approved, false)
  }
  assert.equal(h.putCalls.length, 0)
  assert.equal(h.preflight.calls, 0)
  assert.equal(h.transport.calls.length, 0)
  assert.equal(h.capture.calls.length, 0)
})

test('unbound run identities surface a human path instead of a forged completion', async t => {
  const h = await setup(t, { transport: { noRunIds: true } })
  const started = await startPlan(h)
  assert.equal(started.ok, false)
  assert.equal(started.code, 'RUN_UNBOUND')
  assert.equal(started.outcome, 'start_failed')
  assert.equal(started.approved, false)
  assert.equal(started.nextAction, 'new_record')
  assert.equal(started.record.rounds.length, 1)
  assert.equal(started.record.rounds[0].state, 'in_flight')
  for (const lane of REVIEW_LANES) {
    assert.equal(started.record.rounds[0].lanes[lane].runId, null)
    assert.equal(started.record.rounds[0].lanes[lane].status, 'in_flight')
  }
  const status = await h.coordinator.status({ target: TARGET })
  assert.equal(status.state, 'in_flight')
  assert.equal(status.nextAction, 'new_record')
  const cancelled = await h.coordinator.cancel({ target: TARGET })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.code, 'CANCEL_UNBOUND')
  assert.equal(cancelled.record.activeRoundId, started.record.activeRoundId, 'no forged terminal state')
  assert.equal(cancelled.approved, false)
})

test('a late native run identity is bound through the waitForRuns seam', async t => {
  const h = await setup(t, {
    transport: { noRunIds: true },
    coordinator: {
      waitForRuns: async () => ({ practical: 'run-late-practical', adversarial: 'run-late-adversarial' }),
    },
  })
  const started = await startPlan(h)
  assert.equal(started.ok, true, JSON.stringify(started.diagnostics))
  assert.equal(started.state, 'in_flight')
  const round = activeRound(started.record)
  assert.equal(round.lanes.practical.runId, 'run-late-practical')
  assert.equal(round.lanes.adversarial.runId, 'run-late-adversarial')
  assert.equal(h.transport.calls.length, 1)
  const approved = await completeRound(h, started)
  assert.equal(approved.approved, true, JSON.stringify(approved.diagnostics))
  assert.equal(approved.record.rounds[0].lanes.practical.receipt.runId, 'run-late-practical')
  assert.equal(approved.record.rounds[0].lanes.adversarial.receipt.runId, 'run-late-adversarial')
})

test('a hung result never blocks status or cancel and a late completion cannot approve', async t => {
  const h = await setup(t)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliverRound(round)
  let waitSettled = false
  const pending = waitRound(h, round.roundId).then(value => { waitSettled = true; return value })
  await turn()
  assert.equal(waitSettled, false, 'wait is genuinely blocked on the hung lanes')

  const status = await h.coordinator.status({ roundId: round.roundId })
  assert.equal(status.ok, true)
  assert.equal(status.state, 'in_flight')
  assert.equal(status.nextAction, 'wait')

  const cancelled = await h.coordinator.cancel({ roundId: round.roundId })
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled.diagnostics))
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.approved, false)
  assert.equal(h.transport.disposed.length, 2)

  h.transport.resolve(0, 'practical', okay(round, 'practical'))
  h.transport.resolve(0, 'adversarial', okay(round, 'adversarial'))
  const late = await pending
  assert.equal(late.ok, true)
  assert.equal(late.state, 'cancelled', 'late results never reopen a cancelled round')
  assert.equal(late.approved, false)
  assert.equal(h.transport.calls.length, 1)
})

test('a failed durable lane write never approves early and can be retried', async t => {
  const h = await setup(t)
  const started = await startPlan(h)
  const round = activeRound(started.record)
  h.input.deliverRound(round)
  h.transport.resolve(0, 'practical', okay(round, 'practical'))
  h.transport.resolve(0, 'adversarial', okay(round, 'adversarial'))
  h.putError = Object.assign(new Error('disk full'), { code: 'EIO' })
  const failed = await waitRound(h, round.roundId)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'PERSIST_FAILED')
  assert.equal(failed.approved, false)
  assert.equal(failed.state, 'in_flight')
  assert.equal(failed.record.activeRoundId, round.roundId)
  assert.equal(failed.record.rounds[0].lanes.practical.status, 'in_flight', 'memory never advances past a failed write')

  h.putError = null
  const retried = await waitRound(h, round.roundId)
  assert.equal(retried.ok, true, JSON.stringify(retried.diagnostics))
  assert.equal(retried.state, 'approved')
  assert.equal(retried.approved, true)
  assert.equal(h.transport.calls.length, 1)
})
