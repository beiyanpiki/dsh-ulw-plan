/**
 * The planning guard's decision table: mode x tool x target.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearHandoffAuthority, handoffAuthorityOf, setHandoffAuthority } from '../lib/commands.js'
import { createGuard } from '../lib/guard.js'

const cwd = '/ws'
const session = { header: { cwd } }
const agent = { session }

function guardFor(mode) {
  const ctx = {
    sessionProjections: { stateOf: () => ({ mode }) },
    workingDirectory: { get: () => cwd },
  }
  return createGuard(ctx)
}

const call = (name, filePath, useAgent = agent) => ({ name, arguments: { file_path: filePath }, agent: useAgent })

test('plan mode refuses a product write with exit instructions', () => {
  const reason = guardFor('plan')(call('write', 'src/main.ts'))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /\/ulw-mode execute/)
  assert.match(reason, /\/ulw-mode off/)
})

test('plan mode refuses a product edit', () => {
  assert.equal(typeof guardFor('plan')(call('edit', 'src/main.ts')), 'string')
})

test('plan mode allows writing a plan under .dsh/ulw/', () => {
  assert.equal(guardFor('plan')(call('write', '.dsh/ulw/plans/x.md')), undefined)
  assert.equal(guardFor('plan')(call('edit', `${cwd}/.dsh/ulw/drafts/x.md`)), undefined)
})

test('plan mode refuses traversal out of the artifact root', () => {
  assert.equal(typeof guardFor('plan')(call('write', '.dsh/ulw/../src/x.ts')), 'string')
})

test('execute and off modes do not gate product writes', () => {
  assert.equal(guardFor('execute')(call('write', 'src/main.ts')), undefined)
  assert.equal(guardFor('off')(call('write', 'src/main.ts')), undefined)
})

test('plan mode does not gate bash or read-only tools', () => {
  assert.equal(guardFor('plan')(call('bash', undefined)), undefined)
  assert.equal(guardFor('plan')(call('read', 'src/main.ts')), undefined)
  assert.equal(guardFor('plan')(call('grep', 'src/main.ts')), undefined)
})

test('an execution without an agent is never gated', () => {
  assert.equal(guardFor('plan')({ name: 'write', arguments: { file_path: 'src/main.ts' } }), undefined)
})

// ---------------------------------------------------------------------------
// ULW row 36: the guard reads the handoff authority through the plugin seam
// ---------------------------------------------------------------------------

test('row 36: execute mode reads the seam and contains the Cordis property traps', () => {
  const ctx = {
    sessionProjections: { stateOf: () => ({ mode: 'execute' }) },
    workingDirectory: { get: () => cwd },
  }
  // The real Cordis get/set traps for an undeclared property.
  Object.defineProperty(ctx, 'handoff', {
    configurable: true,
    get() { throw new Error('cannot get property "handoff" without inject') },
    set() { throw new Error('cannot set property "handoff" without provide') },
  })

  const seam = { guard: (exec) => (exec.name === 'write' ? 'REFUSED_BY_SEAM' : undefined) }
  setHandoffAuthority(ctx, seam)
  assert.equal(handoffAuthorityOf(ctx), seam)
  assert.equal(createGuard(ctx)(call('write', 'src/main.ts')), 'REFUSED_BY_SEAM')
  assert.equal(createGuard(ctx)(call('read', 'src/main.ts')), undefined)

  clearHandoffAuthority(ctx, seam)
  assert.equal(handoffAuthorityOf(ctx), null)
  // No seam on a real context is the old Host's execute behaviour: ungated,
  // never a raw property TypeError.
  assert.equal(createGuard(ctx)(call('write', 'src/main.ts')), undefined)
  assert.equal(createGuard(ctx)(call('bash', undefined)), undefined)
})

test('row 36: a legacy plain-object handoff property remains the read fallback', () => {
  const legacy = { guard: () => 'REFUSED_BY_LEGACY' }
  const ctx = {
    sessionProjections: { stateOf: () => ({ mode: 'execute' }) },
    workingDirectory: { get: () => cwd },
    handoff: legacy,
  }
  assert.equal(createGuard(ctx)(call('write', 'src/main.ts')), 'REFUSED_BY_LEGACY')
  clearHandoffAuthority(ctx, legacy)
  assert.equal(createGuard(ctx)(call('write', 'src/main.ts')), undefined)
})

// ---------------------------------------------------------------------------
// ULW row 13: the execute-mode handoff lease gate
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeInstructionSha256 } from '../lib/review-artifact.js'
import { createHandoffService } from '../lib/review-handoff.js'

const HANDOFF_PLAN = '# Gate plan\n## Todos\n- [ ] 1. task\n  QA: assert it\n## Final verification wave\n- [ ] F1. audit\n'
const HANDOFF_TARGET = '.dsh/ulw/plans/gate.md'
const HANDOFF_POLICY = 'a'.repeat(64)

async function handoffFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ulw-guard-handoff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.dsh/ulw/plans'), { recursive: true })
  await mkdir(join(root, '.dsh/ulw/drafts'), { recursive: true })
  const path = join(root, HANDOFF_TARGET)
  await writeFile(path, HANDOFF_PLAN)
  const source = {
    planSha256: createHash('sha256').update(Buffer.from(HANDOFF_PLAN)).digest('hex'),
    instructionSha256: computeInstructionSha256(HANDOFF_PLAN),
  }
  const receipt = lane => ({
    lane, roundId: 'round-1', launchId: 'launch-1', childId: 'child-' + lane, runId: 'run-' + lane,
    planSha256: source.planSha256, instructionSha256: source.instructionSha256,
    verdict: 'OKAY', stopReason: 'completed', resultSha256: 'b'.repeat(64),
    coverage: { complete: true, pages: 1, deliveredBytes: 1, totalBytes: 1, planSha256: source.planSha256, instructionSha256: source.instructionSha256 },
  })
  const approved = {
    ok: true, exists: true, required: true, approved: true, state: 'approved', roundId: 'round-1',
    revision: 1, changed: true, persisted: true, nextAction: null, source,
    policy: { policySha256: HANDOFF_POLICY },
    receipts: { practical: receipt('practical'), adversarial: receipt('adversarial') },
  }
  const review = { value: approved, approval: () => ({ ...review.value }) }
  const service = createHandoffService({ workspace: root, review, policySha256: HANDOFF_POLICY, leaseTtlMs: 500 })
  const session = (id = 'guard-author', cwd = root) => ({ header: { id, cwd } })
  const ctxFor = (mode, current = 'guard-author', cwd = root) => ({
    sessionProjections: { stateOf: () => ({ mode }) },
    workingDirectory: { get: () => cwd },
    handoff: service,
  })
  const guard = (mode, sessionId = 'guard-author', cwd = root) => createGuard(ctxFor(mode, sessionId, cwd))
  const callFor = (name, filePath, sessionId = 'guard-author', cwd = root) => ({
    name, arguments: { file_path: filePath }, agent: { session: session(sessionId, cwd) },
  })
  const authorize = async (over = {}) => {
    const result = await service.check({ action: 'check', target: HANDOFF_TARGET }, { author: { sessionId: 'guard-author' }, synchronous: true, at: 1000, ...over })
    assert.equal(result.ok, true, JSON.stringify(result))
    return result
  }
  return { root, path, service, review, guard, callFor, authorize, session }
}

test('without a handoff service execute mode keeps the old behaviour', async t => {
  const f = await handoffFixture(t)
  const guard = createGuard({ sessionProjections: { stateOf: () => ({ mode: 'execute' }) }, workingDirectory: { get: () => f.root } })
  assert.equal(guard(f.callFor('write', 'src/main.ts')), undefined)
  assert.equal(guard(f.callFor('bash', undefined)), undefined)
})

test('with a handoff service a fresh execute session cannot write before check', async t => {
  const f = await handoffFixture(t)
  const guard = f.guard('execute')
  for (const [name, path] of [['write', 'src/main.ts'], ['edit', 'src/main.ts'], ['bash', undefined], ['subagent', undefined], ['run_code', undefined]]) {
    const reason = guard(f.callFor(name, path))
    assert.equal(typeof reason, 'string', name)
    assert.match(reason, /HANDOFF_LEASE_MISSING/)
    assert.match(reason, /ulw-mode off/)
  }
  assert.equal(guard(f.callFor('read', 'src/main.ts')), undefined)
  assert.equal(guard(f.callFor('write', '.dsh/ulw/plans/gate.md')), undefined)
  // The tools that can open the gate must stay available before the lease.
  for (const name of ['ulw_handoff', 'ulw_review', 'ulw_review_input']) {
    assert.equal(guard(f.callFor(name, undefined)), undefined, name)
  }
  // A direct skill load only records execute intent; the lease gate stays shut.
  assert.equal(typeof guard(f.callFor('write', 'src/main.ts')), 'string')
  await f.authorize()
  assert.equal(guard(f.callFor('write', 'src/main.ts')), undefined)
  for (const name of ['ulw_handoff', 'ulw_review', 'ulw_review_input']) {
    assert.equal(guard(f.callFor(name, undefined)), undefined, name + ' after lease')
  }
})

test('a required plan without a verified lease refuses product writes, shell and spawns', async t => {
  const f = await handoffFixture(t)
  f.review.value = {
    ok: true, exists: true, required: true, approved: false, state: 'in_flight', roundId: null,
    revision: 0, nextAction: 'wait', source: { planSha256: null, instructionSha256: null },
  }
  const check = await f.service.check({ action: 'check', target: HANDOFF_TARGET }, { author: { sessionId: 'guard-author' }, synchronous: true, at: 1000 })
  assert.equal(check.ok, false)
  const guard = f.guard('execute')
  for (const [name, path] of [['write', 'src/main.ts'], ['edit', 'config/app.json'], ['bash', undefined], ['subagent', undefined], ['subagent_fork', undefined], ['run_code', undefined]]) {
    const reason = guard(f.callFor(name, path))
    assert.equal(typeof reason, 'string', name)
    assert.match(reason, /\/ulw-mode off/)
    assert.match(reason, /ulw_handoff check/)
  }
  for (const name of ['read', 'glob', 'grep', 'todo_write', 'ask_user_question']) {
    assert.equal(guard(f.callFor(name, 'src/main.ts')), undefined, name)
  }
  for (const name of ['ulw_handoff', 'ulw_review', 'ulw_review_input']) {
    assert.equal(guard(f.callFor(name, undefined)), undefined, name)
  }
  assert.equal(guard(f.callFor('write', '.dsh/ulw/plans/gate.md')), undefined)
  assert.equal(guard(f.callFor('edit', '.dsh/ulw/drafts/gate.md')), undefined)
  assert.equal(typeof guard(f.callFor('write', '.dsh/ulw/boulder.json')), 'string')
})

test('a verified required lease allows execute and an instruction edit revokes it', async t => {
  const f = await handoffFixture(t)
  await f.authorize()
  const guard = f.guard('execute')
  assert.equal(guard(f.callFor('write', 'src/main.ts')), undefined)
  assert.equal(guard(f.callFor('bash', undefined)), undefined)
  assert.equal(guard(f.callFor('subagent', undefined)), undefined)
  await writeFile(f.path, HANDOFF_PLAN.replace('QA: assert it', 'QA: changed'))
  const reason = guard(f.callFor('write', 'src/main.ts'))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /HANDOFF_STALE_SOURCE/)
  assert.equal(typeof guard(f.callFor('bash', undefined)), 'string')
})

test('an ordinary lease allows product work without any review', async t => {
  const f = await handoffFixture(t)
  f.review.value = { ok: true, exists: false }
  await f.authorize()
  const guard = f.guard('execute')
  assert.equal(guard(f.callFor('write', 'src/main.ts')), undefined)
  assert.equal(guard(f.callFor('bash', undefined)), undefined)
})

test('a revoked lease returns to the gate', async t => {
  const f = await handoffFixture(t)
  const result = await f.authorize()
  const guard = f.guard('execute')
  assert.equal(guard(f.callFor('write', 'src/main.ts')), undefined)
  await f.service.revoke(result.handoffId, { host: true })
  assert.equal(typeof guard(f.callFor('write', 'src/main.ts')), 'string')
  assert.equal(typeof guard(f.callFor('bash', undefined)), 'string')
})

test('plan mode still refuses product writes and still permits planning bash', async t => {
  const f = await handoffFixture(t)
  await f.authorize()
  const planGuard = f.guard('plan')
  assert.equal(typeof planGuard(f.callFor('write', 'src/main.ts')), 'string')
  assert.equal(planGuard(f.callFor('bash', undefined)), undefined)
  assert.equal(planGuard(f.callFor('write', '.dsh/ulw/plans/gate.md')), undefined)
})
