/**
 * Command tests: the `/ulw-mode` validation surface, the `/ulw-review`
 * target resolver, and the followup injection both role commands perform.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ULW_CONSULT_COMMAND,
  ULW_MODE_USAGE,
  ULW_REVIEW_COMMAND,
  loadContract,
  registerCommands,
  resolveReviewTarget,
} from '../lib/commands.js'
import { buildReviewFollowup, buildReviewReceipt } from '../lib/review-tools.js'

const workspace = () => mkdtempSync(join(tmpdir(), 'dsh-ulw-plan-commands-'))

/** A minimal agent double that records every queued followup turn. */
function fakeAgent(cwd, sessionId = 'session-1') {
  const followups = []
  return {
    followups,
    session: { id: sessionId, header: { cwd } },
    followup(message) {
      followups.push(message)
    },
  }
}

/** A context double exposing only what the command handlers touch. */
function fakeCtx(mode = 'off') {
  const registrations = []
  return {
    registrations,
    commands: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    sessionProjections: {
      stateOf: (_session, key) => (key === 'ulwMode' ? { mode } : undefined),
    },
    workingDirectory: { get: () => '/fallback-ws' },
  }
}

const byName = (ctx, name) => ctx.registrations.find((definition) => definition.name === name)

const invoke = (definition, rawInput, agent) => definition.handler({ rawInput, agent })

/** A Handoff authority double: the only member the command gate may read. */
function fakeHandoff(states = {}, options = {}) {
  const calls = []
  return {
    calls,
    stateForSession(sessionId) {
      calls.push(sessionId)
      if (options.throw === true) throw new Error('handoff state unavailable')
      return states[sessionId] ?? null
    },
  }
}

/** One active execute lease as `stateForSession` reports it (leased or bound). */
function activeLeaseState(overrides = {}) {
  return {
    status: 'leased',
    required: true,
    lease: { handoffId: 'handoff-test-1', required: true },
    ...overrides,
  }
}

/** A review router double that answers with the shipped accepted-round receipt. */
function fakeRouter() {
  const calls = []
  return {
    calls,
    command(request) {
      calls.push(request)
      const envelope = { roundId: 'round-test-1', launchId: 'launch-test-1' }
      return Promise.resolve({
        result: { kind: 'success', text: buildReviewReceipt(envelope, request.target.absolute) },
        followup: buildReviewFollowup(envelope, request.target.absolute),
      })
    },
  }
}

/** A plan fixture plus one registered command surface for the lease-gate tests. */
function reviewSetup(mode, handoff) {
  const cwd = workspace()
  const target = join(cwd, '.dsh', 'ulw', 'plans', 'feature.md')
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(target, '# feature plan')
  const ctx = fakeCtx(mode)
  if (handoff !== undefined) ctx.handoff = handoff
  const router = fakeRouter()
  registerCommands(ctx, { review: router })
  const agent = fakeAgent(cwd)
  return {
    cwd,
    ctx,
    router,
    agent,
    digest: createHash('sha256').update(readFileSync(target)).digest('hex'),
    invokeReview: (who = agent) => invoke(byName(ctx, ULW_REVIEW_COMMAND), '.dsh/ulw/plans/feature.md', who),
  }
}

test('registerCommands mounts all three commands and returns one disposer', () => {
  const ctx = fakeCtx()
  const dispose = registerCommands(ctx)
  assert.deepEqual(
    ctx.registrations.map((definition) => definition.name).sort(),
    ['ulw-consult', 'ulw-mode', 'ulw-review'],
  )
  assert.equal(typeof dispose, 'function')
})

test('ulw-mode validates its argument and never touches the agent', () => {
  const ctx = fakeCtx()
  registerCommands(ctx)
  const command = byName(ctx, 'ulw-mode')
  const agent = fakeAgent(workspace())
  assert.deepEqual(invoke(command, ' plan ', agent), { kind: 'success', text: 'ulw mode: plan' })
  assert.deepEqual(invoke(command, 'bogus', agent), { kind: 'error', text: ULW_MODE_USAGE })
  assert.equal(agent.followups.length, 0)
})

test('the role contracts load from the skill references', () => {
  const reviewer = loadContract('plan-reviewer')
  const consultant = loadContract('plan-consultant')
  assert.match(reviewer, /\.dsh\/ulw\/plans/)
  assert.equal(reviewer.includes('.omo'), false)
  assert.equal(consultant.includes('.omo'), false)
  assert.ok(reviewer.length > 500 && consultant.length > 500)
})

test('resolveReviewTarget accepts one existing markdown plan', () => {
  const cwd = workspace()
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), '# feature plan')
  const expected = createHash('sha256').update('# feature plan').digest('hex')

  const relative = resolveReviewTarget('.dsh/ulw/plans/feature.md', cwd)
  assert.equal(relative.ok, true)
  assert.equal(relative.absolute, join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'))
  assert.equal(relative.digest, expected)

  const absolute = resolveReviewTarget(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), cwd)
  assert.equal(absolute.ok, true)
  assert.equal(absolute.digest, expected)
})

test('resolveReviewTarget rejects unusable targets', () => {
  const cwd = workspace()
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), '# feature plan')

  assert.match(resolveReviewTarget('', cwd).error, /Usage: \/ulw-review/)
  assert.match(resolveReviewTarget('   ', cwd).error, /Usage: \/ulw-review/)
  assert.match(resolveReviewTarget('readme.txt', cwd).error, /Usage: \/ulw-review/)
  assert.match(resolveReviewTarget('.dsh/ulw/plans/flow.yml', cwd).error, /YAML plans are not reviewable/)
  assert.match(resolveReviewTarget('docs/feature.md', cwd).error, /must live under \.dsh\/ulw\/plans\//)
  assert.match(resolveReviewTarget('.dsh/ulw/drafts/feature.md', cwd).error, /must live under \.dsh\/ulw\/plans\//)
  assert.match(resolveReviewTarget('.dsh/ulw/plans/missing.md', cwd).error, /no such plan file/)
})

test('ulw-review injects the reviewer contract with the literal target and digest', () => {
  const cwd = workspace()
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), '# feature plan')
  const digest = createHash('sha256').update('# feature plan').digest('hex')

  const ctx = fakeCtx('plan')
  registerCommands(ctx)
  const agent = fakeAgent(cwd)
  const result = invoke(byName(ctx, ULW_REVIEW_COMMAND), '  .dsh/ulw/plans/feature.md ', agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /reviewer contract injected/)
  assert.equal(agent.followups.length, 1)
  const message = agent.followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'user')
  assert.equal(typeof message.id, 'string')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  const text = message.content[0].text
  assert.match(text, /\/ulw-review/)
  assert.ok(text.includes(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md')))
  assert.ok(text.includes(digest))
  assert.match(text, /plan-reviewer contract|reviewer contract/i)
  assert.equal(text.includes('.omo'), false)
})

test('ulw-review accepts execute mode before any lease, including the no-router fallback, and reports invalid targets without injecting', () => {
  const cwd = workspace()
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), '# feature plan')
  const ctx = fakeCtx('execute')
  registerCommands(ctx)
  const agent = fakeAgent(cwd)

  const accepted = invoke(byName(ctx, ULW_REVIEW_COMMAND), '.dsh/ulw/plans/feature.md', agent)
  assert.equal(accepted.kind, 'success')
  assert.match(accepted.text, /reviewer contract injected/)
  assert.equal(agent.followups.length, 1)

  const offline = fakeCtx('off')
  registerCommands(offline)
  const invalidAgent = fakeAgent(cwd)
  const invalid = invoke(byName(offline, ULW_REVIEW_COMMAND), 'nope.md', invalidAgent)
  assert.equal(invalid.kind, 'error')
  assert.match(invalid.text, /Usage: \/ulw-review|no such plan file|must live under/)
  assert.equal(invalidAgent.followups.length, 0)
})

test('execute mode without a handoff lease accepts the round and returns the accepted receipt', async () => {
  const handoff = fakeHandoff({})
  const setup = reviewSetup('execute', handoff)
  const result = await setup.invokeReview()

  assert.equal(result.kind, 'success')
  assert.match(result.text, /accepted round round-test-1/)
  assert.match(result.text, /This receipt is NOT a completed review/)
  assert.equal(/approved: yes|\[OKAY\]/.test(result.text), false, 'the receipt must never fabricate approval')
  assert.deepEqual(handoff.calls, ['session-1'], 'the gate resolves the lease for the command session')
  assert.equal(setup.router.calls.length, 1)
  assert.equal(setup.router.calls[0].target.digest, setup.digest)
  assert.equal(setup.agent.followups.length, 1)
  const followup = setup.agent.followups[0].content[0].text
  assert.match(followup, /ACCEPTED but NOT completed/)
  assert.match(followup, /not a new user approval/)
})

test('execute mode without any handoff keeps accepting the round (old Host composition)', async () => {
  const setup = reviewSetup('execute')
  const result = await setup.invokeReview()
  assert.equal(result.kind, 'success')
  assert.match(result.text, /accepted round round-test-1/)
  assert.equal(setup.router.calls.length, 1)
  assert.equal(setup.agent.followups.length, 1)
})

test('execute mode with an active lease refuses with HANDOFF_ACTIVE_EXECUTE and accepts no round', async () => {
  const handoff = fakeHandoff({ 'session-1': activeLeaseState() })
  const setup = reviewSetup('execute', handoff)
  const result = await setup.invokeReview()

  assert.equal(result.kind, 'error')
  assert.match(result.text, /HANDOFF_ACTIVE_EXECUTE/)
  assert.equal(result.text.includes('CAPABILITY_UNAVAILABLE'), false, 'the lease refusal carries its own stable code')
  assert.equal(/accepted round|NOT a completed review/.test(result.text), false, 'a refusal never fabricates a receipt')
  assert.equal(setup.router.calls.length, 0)
  assert.equal(setup.agent.followups.length, 0)

  // The rule covers any active execution lease (plan design line 53: only an execute
  // that already holds a lease refuses the plan review), not only required ones.
  const bound = reviewSetup('execute', fakeHandoff({
    'session-1': activeLeaseState({ status: 'bound', required: false, lease: { handoffId: 'handoff-test-2', required: false } }),
  }))
  const boundResult = await bound.invokeReview()
  assert.equal(boundResult.kind, 'error')
  assert.match(boundResult.text, /HANDOFF_ACTIVE_EXECUTE/)
  assert.equal(bound.router.calls.length, 0)
  assert.equal(bound.agent.followups.length, 0)

  // The gate is router-independent: the standalone inline path refuses identically.
  const inlineCtx = fakeCtx('execute')
  inlineCtx.handoff = handoff
  registerCommands(inlineCtx)
  const inlineAgent = fakeAgent(setup.cwd)
  const inline = invoke(byName(inlineCtx, ULW_REVIEW_COMMAND), '.dsh/ulw/plans/feature.md', inlineAgent)
  assert.equal(inline.kind, 'error')
  assert.match(inline.text, /HANDOFF_ACTIVE_EXECUTE/)
  assert.equal(inlineAgent.followups.length, 0)
})

test('an unreadable handoff state fails closed as capability, never as an accepted lease', async () => {
  const setup = reviewSetup('execute', fakeHandoff({}, { throw: true }))
  const result = await setup.invokeReview()
  assert.equal(result.kind, 'error')
  assert.match(result.text, /CAPABILITY_UNAVAILABLE/)
  assert.equal(result.text.includes('HANDOFF_ACTIVE_EXECUTE'), false)
  assert.equal(setup.router.calls.length, 0)
  assert.equal(setup.agent.followups.length, 0)

  // An asynchronous lookup must not fail open: a Promise is not a lease snapshot.
  const asyncSetup = reviewSetup('execute', { stateForSession: async () => activeLeaseState() })
  const asyncResult = await asyncSetup.invokeReview()
  assert.equal(asyncResult.kind, 'error')
  assert.match(asyncResult.text, /CAPABILITY_UNAVAILABLE/)
  assert.equal(asyncSetup.router.calls.length, 0)
  assert.equal(asyncSetup.agent.followups.length, 0)
})

test('plan and off modes still accept the round and never consult an execute lease', async () => {
  for (const mode of ['plan', 'off']) {
    const handoff = fakeHandoff({ 'session-1': activeLeaseState() })
    const setup = reviewSetup(mode, handoff)
    const result = await setup.invokeReview()
    assert.equal(result.kind, 'success', mode)
    assert.match(result.text, /accepted round round-test-1/)
    assert.equal(handoff.calls.length, 0, mode + ' must not read the execute lease')
    assert.equal(setup.agent.followups.length, 1)
  }
})

test('ulw-consult injects the consultant contract with the request', () => {
  const ctx = fakeCtx('plan')
  registerCommands(ctx)
  const agent = fakeAgent(workspace())

  const empty = invoke(byName(ctx, ULW_CONSULT_COMMAND), '   ', agent)
  assert.equal(empty.kind, 'error')
  assert.match(empty.text, /Usage: \/ulw-consult/)

  const result = invoke(byName(ctx, ULW_CONSULT_COMMAND), 'should we split the auth module?', agent)
  assert.equal(result.kind, 'success')
  assert.equal(agent.followups.length, 1)
  const message = agent.followups[0]
  assert.equal(message.role, 'user')
  const text = message.content[0].text
  assert.match(text, /\/ulw-consult/)
  assert.ok(text.includes('should we split the auth module?'))
  assert.match(text, /Intent Classification|consultant contract/i)
})

test('ulw-consult refuses while executing', () => {
  const ctx = fakeCtx('execute')
  registerCommands(ctx)
  const agent = fakeAgent(workspace())
  const result = invoke(byName(ctx, ULW_CONSULT_COMMAND), 'anything', agent)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /ulw-execute mode/)
  assert.equal(agent.followups.length, 0)
})
