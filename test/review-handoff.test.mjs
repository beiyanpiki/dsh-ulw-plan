/**
 * Handoff lease contract for ULW plan row 13.
 *
 * A required plan may not gain execute from a skill invocation, a mode change,
 * a draft OKAY, a copied receipt or a guessed lease: the Host must read the
 * durable dual-review approval, revalidate the live raw/instruction digests and
 * issue an explicit revocable lease. Ordinary plans get an ordinary lease with
 * zero review starts. Expiry is decided only by explicit \`at\`/\`expiresAt\`
 * fields - never by Date.now - so every negative path is deterministic.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { computeInstructionSha256 } from '../lib/review-artifact.js'
import { HANDOFF_LEASE_FIELDS, createHandoffService, createStoreApprovalSource } from '../lib/review-handoff.js'
import { buildPlanSkeleton } from '../skills/ulw-plan/scripts/plan-templates.mjs'
import { applyTick } from '../skills/ulw-execute/scripts/plan-state.mjs'

const TARGET = '.dsh/ulw/plans/demo.md'
const OTHER = '.dsh/ulw/plans/other.md'
const POLICY = 'f'.repeat(64)
const PLAN = '# Demo plan\r\n## Todos\r\n- [ ] 1. implement\r\n  QA: assert bytes\r\n## Final verification wave\r\n- [ ] F1. audit\r\n'
const bytesOf = text => Buffer.from(text, 'utf8')
const hashText = text => createHash('sha256').update(bytesOf(text)).digest('hex')
const digests = text => ({ planSha256: hashText(text), instructionSha256: computeInstructionSha256(text) })
const laneReceipt = (lane, roundId, source, over = {}) => ({
  lane,
  roundId,
  launchId: 'launch-' + roundId,
  childId: 'child-' + lane,
  runId: 'run-' + lane,
  planSha256: source.planSha256,
  instructionSha256: source.instructionSha256,
  verdict: 'OKAY',
  stopReason: 'completed',
  coverage: {
    complete: true,
    pages: 1,
    deliveredBytes: 1,
    totalBytes: 1,
    planSha256: source.planSha256,
    instructionSha256: source.instructionSha256,
  },
  resultSha256: 'c'.repeat(64),
  ...over,
})
const receiptsFor = (roundId, source) => ({
  practical: laneReceipt('practical', roundId, source),
  adversarial: laneReceipt('adversarial', roundId, source),
})
function approvalFor(text, over = {}) {
  const source = over.source ?? digests(text)
  const roundId = over.roundId ?? 'round-1'
  return {
    ok: true,
    exists: true,
    required: true,
    approved: true,
    state: 'approved',
    roundId,
    revision: 1,
    changed: true,
    persisted: true,
    nextAction: null,
    source,
    policy: { policySha256: POLICY },
    receipts: receiptsFor(roundId, source),
    ...over,
  }
}
function reviewDouble(initial = { ok: true, exists: false }) {
  let value = initial
  const calls = []
  return {
    calls,
    starts: 0,
    set(next) { value = next },
    approval(identity) {
      calls.push(identity)
      return typeof value === 'function' ? value(identity) : value
    },
  }
}
async function workspacePlan(t, text = PLAN, target = TARGET) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-ulw-handoff-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, '.dsh/ulw/plans'), { recursive: true })
  await mkdir(join(workspace, '.dsh/ulw/drafts'), { recursive: true })
  await writeFile(join(workspace, target), text)
  return { workspace, target, path: join(workspace, target), text }
}
function serviceFor(t, f, review, over = {}) {
  const service = createHandoffService({
    workspace: f.workspace,
    review,
    policySha256: POLICY,
    leaseTtlMs: 1000,
    ...over,
  })
  t.after(() => service.close?.())
  return service
}
const AUTHOR = { author: { sessionId: 'author-1' }, synchronous: true, at: 1000 }
const ctx = (over = {}) => ({ ...AUTHOR, ...over, author: { ...AUTHOR.author, ...(over.author ?? {}) } })
const check = target => ({ action: 'check', target })
const bootstrap = target => ({ action: 'bootstrap', target })
const bind = (target, worktreePath) => ({ action: 'bind-worktree', target, worktreePath })
function denied(result, code, nextAction) {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, code, JSON.stringify(result))
  assert.equal(result.nextAction, nextAction, JSON.stringify(result))
  assert.equal(Array.isArray(result.diagnostics), true)
  assert.equal(result.diagnostics[0]?.code, code)
}

// ---------------------------------------------------------------------------
// ordinary plans
// ---------------------------------------------------------------------------

test('an ordinary plan gets an ordinary lease without starting a review', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble({ ok: true, exists: false })
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome, 'ordinary_lease')
  assert.equal(result.required, false)
  assert.equal(result.nextAction, 'execute')
  assert.equal(result.lease.required, false)
  assert.equal(result.lease.approvedRoundId, null)
  assert.equal(result.lease.approvedSourceSha256, null)
  assert.equal(result.lease.reviewedAt, 1000)
  assert.equal(result.receipt, null)
  assert.equal(review.starts, 0)
  for (const field of HANDOFF_LEASE_FIELDS) assert.equal(Object.hasOwn(result.lease, field), true, field)
  const checked = await service.assertLease(result.lease, { at: 1000, target: f.target })
  assert.equal(checked.ok, true, JSON.stringify(checked))
  assert.equal(checked.nextAction, 'execute')
})

test('an ordinary check never invokes any review coordinator action', async t => {
  const f = await workspacePlan(t)
  const touched = []
  const review = new Proxy({
    approval() {
      touched.push('approval')
      return { ok: true, exists: false }
    },
  }, {
    get(target, property, receiver) {
      if (['require', 'start', 'wait', 'cancel', 'status'].includes(property)) {
        throw new Error('the handoff started a review action: ' + String(property))
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome, 'ordinary_lease')
  assert.deepEqual(touched, ['approval'])
})

test('a false legacy draft flag leaves an ordinary plan ordinary', async t => {
  const f = await workspacePlan(t)
  await writeFile(join(f.workspace, '.dsh/ulw/drafts/demo.md'), '---\nslug: demo\nreview_required: false\n---\n# Draft\n')
  const review = reviewDouble({ ok: true, exists: false })
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.required, false)
  assert.equal(review.starts, 0)
})

// ---------------------------------------------------------------------------
// verified required lease and receipts
// ---------------------------------------------------------------------------

test('a verified two-lane approval yields the exact required lease fields', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome, 'required_lease')
  assert.equal(result.required, true)
  assert.equal(result.nextAction, 'execute')
  const d = digests(f.text)
  const lease = result.lease
  for (const field of HANDOFF_LEASE_FIELDS) assert.equal(Object.hasOwn(lease, field), true, field)
  assert.equal(lease.handoffId, result.handoffId)
  assert.equal(lease.planSha256, d.planSha256)
  assert.equal(lease.instructionSha256, d.instructionSha256)
  assert.equal(lease.approvedRoundId, 'round-1')
  assert.equal(lease.approvedSourceSha256, d.planSha256)
  assert.equal(lease.reviewedAt, 1000)
  assert.equal(lease.expiresAt, 2000)
  assert.equal(result.receipt.roundId, 'round-1')
  assert.deepEqual(result.receipt.lanes.map(lane => lane.lane).sort(), ['adversarial', 'practical'])
  assert.equal(result.receipt.lanes.length, 2)
  const checked = await service.assertLease(lease, { at: 1000, target: f.target })
  assert.equal(checked.ok, true, JSON.stringify(checked))
})

test('the receipt is deduplicated per round and refreshed for a new round', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const first = await service.check(check(f.target), ctx())
  const second = await service.check(check(f.target), ctx())
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.receipt, first.receipt)
  assert.equal(second.receipt.lanes.length, 2)
  review.set(approvalFor(f.text, { roundId: 'round-2', revision: 2 }))
  const third = await service.check(check(f.target), ctx())
  assert.equal(third.ok, true, JSON.stringify(third))
  assert.equal(third.receipt.roundId, 'round-2')
  assert.notEqual(third.receipt, first.receipt)
  assert.equal(third.receipt.lanes.length, 2)
  assert.equal(third.lease.approvedRoundId, 'round-2')
})

test('a verified required lease is revocable and a fresh check re-verifies', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  const revoked = await service.revoke(result.handoffId, { host: true })
  assert.equal(revoked.ok, true, JSON.stringify(revoked))
  const checked = await service.assertLease(result.lease, { at: 1000, target: f.target })
  denied(checked, 'HANDOFF_LEASE_REVOKED', 'check')
  const again = await service.check(check(f.target), ctx())
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.notEqual(again.handoffId, result.handoffId)
})

// ---------------------------------------------------------------------------
// required refusals
// ---------------------------------------------------------------------------

test('an unapproved required plan is refused with the review next action', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble({
    ok: true, exists: true, required: true, approved: false, state: 'in_flight',
    roundId: null, revision: 0, nextAction: 'wait', source: { planSha256: null, instructionSha256: null },
  })
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  denied(result, 'HANDOFF_NOT_APPROVED', 'wait')
  assert.equal(service.stateForSession('author-1')?.status, 'checked')
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: agentFor(f, 'author-1') })
  assert.equal(typeof guard, 'string')
  assert.match(guard, /\/ulw-mode off/)
  assert.match(guard, /ulw_handoff check/)
  assert.equal(service.guard({ name: 'read', arguments: { file_path: 'src/main.ts' }, agent: agentFor(f, 'author-1') }), undefined)
})

test('an approved state with a non-null next action is stale', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text, { nextAction: 'status' }))
  const service = serviceFor(t, f, review)
  denied(await service.check(check(f.target), ctx()), 'HANDOFF_APPROVAL_STALE', 'review')
})

test('a new approval must be persisted and changed', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text, { persisted: false }))
  const service = serviceFor(t, f, review)
  denied(await service.check(check(f.target), ctx()), 'HANDOFF_APPROVAL_UNPERSISTED', 'review')
  const second = reviewDouble(approvalFor(f.text, { changed: false }))
  denied(await serviceFor(t, f, second).check(check(f.target), ctx()), 'HANDOFF_APPROVAL_UNPERSISTED', 'review')
})

test('a source edited after review loses execute and returns to plan review', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  await writeFile(f.path, f.text.replace('QA: assert bytes', 'QA: skip checks'))
  denied(await service.check(check(f.target), ctx()), 'HANDOFF_STALE_SOURCE', 'review')
})

test('a direct save with a forged OKAY does not unlock a required plan', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble({
    ok: true, exists: true, required: true, approved: false, state: 'required',
    roundId: null, revision: 0, nextAction: 'start', source: { planSha256: null, instructionSha256: null },
  })
  const service = serviceFor(t, f, review)
  const forged = f.text + '\nOKAY\napproved: true\nreview_required: false\n'
  await writeFile(f.path, forged)
  const result = await service.check(check(f.target), ctx())
  denied(result, 'HANDOFF_NOT_APPROVED', 'start')
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: agentFor(f, 'author-1') })
  assert.equal(typeof guard, 'string')
})

test('a copied receipt from an earlier round or another source is refused', async t => {
  const f = await workspacePlan(t)
  const oldSource = digests(f.text)
  const staleReceipts = {
    practical: laneReceipt('practical', 'round-0', oldSource),
    adversarial: laneReceipt('adversarial', 'round-2', oldSource),
  }
  const review = reviewDouble(approvalFor(f.text, { roundId: 'round-2', receipts: staleReceipts }))
  denied(await serviceFor(t, f, review).check(check(f.target), ctx()), 'HANDOFF_RECEIPT_INVALID', 'review')

  const otherSource = { planSha256: '0'.repeat(64), instructionSha256: '1'.repeat(64) }
  const copied = {
    practical: laneReceipt('practical', 'round-3', otherSource),
    adversarial: laneReceipt('adversarial', 'round-3', otherSource),
  }
  const second = reviewDouble(approvalFor(f.text, { roundId: 'round-3', receipts: copied }))
  denied(await serviceFor(t, f, second).check(check(f.target), ctx()), 'HANDOFF_RECEIPT_INVALID', 'review')
})

test('a trusted policy mismatch blocks a required lease', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review, { policySha256: '0'.repeat(64) })
  denied(await service.check(check(f.target), ctx()), 'HANDOFF_POLICY_MISMATCH', 'review')
})

test('a required lease fails closed when the policy cannot be compared', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const unbound = serviceFor(t, f, review, { policySha256: undefined })
  denied(await unbound.check(check(f.target), ctx()), 'HANDOFF_POLICY_UNBOUND', 'review')
  const missing = reviewDouble(approvalFor(f.text, { policy: {} }))
  denied(await serviceFor(t, f, missing).check(check(f.target), ctx()), 'HANDOFF_POLICY_MISMATCH', 'review')
  const matching = reviewDouble(approvalFor(f.text))
  const ok = await serviceFor(t, f, matching).check(check(f.target), ctx())
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.outcome, 'required_lease')
})

test('a legacy draft review_required true needs a trusted approval', async t => {
  const f = await workspacePlan(t)
  await writeFile(join(f.workspace, '.dsh/ulw/drafts/demo.md'), '---\nslug: demo\nreview_required: true\n---\n# Draft\n')
  const review = reviewDouble({ ok: true, exists: false })
  const service = serviceFor(t, f, review)
  denied(await service.check(check(f.target), ctx()), 'HANDOFF_REVIEW_REQUIRED', 'review')
})

// ---------------------------------------------------------------------------
// lease validation matrix
// ---------------------------------------------------------------------------

test('missing, forged, expired, other-plan, other-source and round-drift leases are refused', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  const lease = result.lease

  denied(await service.assertLease(undefined, { at: 1000 }), 'HANDOFF_LEASE_MISSING', 'check')
  denied(await service.assertLease({ ...lease, handoffId: 'handoff-forged' }, { at: 1000 }), 'HANDOFF_LEASE_FORGED', 'check')
  denied(await service.assertLease({ ...lease, instructionSha256: '0'.repeat(64) }, { at: 1000 }), 'HANDOFF_LEASE_FORGED', 'check')
  denied(await service.assertLease(lease, { at: 2000 }), 'HANDOFF_LEASE_EXPIRED', 'check')
  denied(await service.assertLease(lease, { at: 1000, target: OTHER }), 'HANDOFF_LEASE_OTHER_PLAN', 'check')

  review.set(approvalFor(f.text, { source: { planSha256: '2'.repeat(64), instructionSha256: digests(f.text).instructionSha256 } }))
  denied(await service.assertLease(lease, { at: 1000, target: f.target }), 'HANDOFF_LEASE_OTHER_SOURCE', 'check')

  review.set(approvalFor(f.text, { roundId: 'round-2', revision: 2 }))
  denied(await service.assertLease(lease, { at: 1000, target: f.target }), 'HANDOFF_APPROVAL_STALE', 'check')
})

test('a legal tick keeps the lease; an instruction edit revokes it immediately', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  const ticked = applyTick(f.text, '1', 'x')
  assert.equal(ticked.changed, true)
  await writeFile(f.path, ticked.content)
  assert.equal((await service.assertLease(result.lease, { at: 1000, target: f.target })).ok, true)
  const agent = agentFor(f, 'author-1')
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent }), undefined)
  await writeFile(f.path, ticked.content.toString('utf8').replace('QA: assert bytes', 'QA: changed check'))
  denied(await service.assertLease(result.lease, { at: 1000, target: f.target }), 'HANDOFF_STALE_SOURCE', 'review')
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent })
  assert.equal(typeof guard, 'string')
  assert.match(guard, /HANDOFF_STALE_SOURCE/)
})

test('a superseded lease from an earlier round reports approval drift', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const first = await service.check(check(f.target), ctx())
  review.set(approvalFor(f.text, { roundId: 'round-2', revision: 2 }))
  const second = await service.check(check(f.target), ctx())
  assert.equal(second.ok, true, JSON.stringify(second))
  denied(await service.assertLease(first.lease, { at: 1000, target: f.target }), 'HANDOFF_APPROVAL_STALE', 'check')
  assert.equal((await service.assertLease(second.lease, { at: 1000, target: f.target })).ok, true)
})

test('the store approval source marks only a cross-checked record persisted', () => {
  const approval = approvalFor(PLAN)
  const snapshot = {
    approved: true, required: true, state: 'approved', roundId: 'round-1', revision: 1,
    receipts: approval.receipts, source: approval.source, policy: approval.policy,
  }
  const identity = { workspace: '/ws', target: TARGET }
  const store = {
    status: () => ({ ok: true, exists: true, record: { state: 'approved', revision: 1 }, approval: snapshot }),
    approval: () => ({ ...snapshot, ok: true, exists: true, key: 'k', code: null, diagnostics: [] }),
  }
  const source = createStoreApprovalSource(store)
  const value = source.approval(identity)
  assert.equal(value.ok, true)
  assert.equal(value.persisted, true)
  assert.equal(value.state, 'approved')

  const tampered = {
    status: () => ({ ok: true, exists: true, record: { state: 'approved', revision: 1 }, approval: { ...snapshot, roundId: 'round-0' } }),
    approval: () => ({ ...snapshot, ok: true, exists: true, key: 'k', code: null, diagnostics: [] }),
  }
  assert.equal(createStoreApprovalSource(tampered).approval(identity).persisted, false)
})

test('expiry is decided only by explicit timestamps', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review, { leaseTtlMs: 500, now: undefined })
  const result = await service.check(check(f.target), ctx({ at: 1000 }))
  assert.equal(result.lease.reviewedAt, 1000)
  assert.equal(result.lease.expiresAt, 1500)
  assert.equal((await service.assertLease(result.lease, { at: 1499, target: f.target })).ok, true)
  denied(await service.assertLease(result.lease, { at: 1500, target: f.target }), 'HANDOFF_LEASE_EXPIRED', 'check')
})

// ---------------------------------------------------------------------------
// caller discipline
// ---------------------------------------------------------------------------

test('only a synchronous current-author check may gain execute', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  denied(await service.check(check(f.target), ctx({ synchronous: false })), 'HANDOFF_NOT_SYNCHRONOUS', 'check')
  denied(await service.check(check(f.target), ctx({ author: { sessionId: undefined } })), 'HANDOFF_AUTHOR_REQUIRED', 'check')
  const first = await service.check(check(f.target), ctx())
  assert.equal(first.ok, true)
  denied(await service.check(check(f.target), ctx({ author: { sessionId: 'intruder' } })), 'HANDOFF_AUTHOR_MISMATCH', 'check')
  assert.equal((await service.check(check(f.target), ctx())).ok, true)
})

test('a direct skill or manual execute start cannot gain execute without check', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble({ ok: true, exists: false })
  const service = serviceFor(t, f, review)
  const agent = agentFor(f, 'author-1')
  const deniedGuard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent })
  assert.equal(typeof deniedGuard, 'string')
  assert.match(deniedGuard, /HANDOFF_LEASE_MISSING/)
  assert.match(deniedGuard, /ulw_handoff check/)
  assert.equal(service.guard({ name: 'read', arguments: { file_path: 'src/main.ts' }, agent }), undefined)
  const lease = await service.check(check(f.target), ctx())
  assert.equal(lease.ok, true)
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent }), undefined)
})

test('a decoy ordinary target cannot supersede the selected required plan', async t => {
  const f = await workspacePlan(t)
  await mkdir(join(f.workspace, '.dsh/ulw/plans'), { recursive: true })
  await writeFile(join(f.workspace, OTHER), '# Other plan\n## Todos\n- [ ] 1. other\n  QA: other\n## Final verification wave\n- [ ] F1. other\n')
  const pending = {
    ok: true, exists: true, required: true, approved: false, state: 'in_flight', roundId: null,
    revision: 0, nextAction: 'wait', source: { planSha256: null, instructionSha256: null },
  }
  const review = {
    approval(identity) {
      return identity.target === f.target ? pending : { ok: true, exists: false }
    },
  }
  const service = serviceFor(t, f, review)
  denied(await service.check(check(f.target), ctx()), 'HANDOFF_NOT_APPROVED', 'wait')
  denied(await service.check(check(OTHER), ctx()), 'HANDOFF_SELECTION_REQUIRED', 'review')
  const agent = agentFor(f, 'author-1')
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent })
  assert.equal(typeof guard, 'string')
  assert.match(guard, /HANDOFF_LEASE_MISSING/)
  const state = service.stateForSession('author-1')
  assert.equal(state.target, f.target)
  assert.equal(state.lease, null)
})

test('a decoy ordinary target cannot replace a verified required selection', async t => {
  const f = await workspacePlan(t)
  await writeFile(join(f.workspace, OTHER), '# Other plan\n## Todos\n- [ ] 1. other\n  QA: other\n## Final verification wave\n- [ ] F1. other\n')
  const review = {
    approval(identity) {
      return identity.target === f.target ? approvalFor(f.text) : { ok: true, exists: false }
    },
  }
  const service = serviceFor(t, f, review)
  const first = await service.check(check(f.target), ctx())
  assert.equal(first.ok, true, JSON.stringify(first))
  denied(await service.check(check(OTHER), ctx()), 'HANDOFF_SELECTION_REQUIRED', 'review')
  const state = service.stateForSession('author-1')
  assert.equal(state.target, f.target)
  assert.equal(state.handoffId, first.handoffId)
  assert.equal(state.required, true)
  assert.equal(state.lease.approvedRoundId, 'round-1')
})

test('review is closed only during an active execute lease', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  assert.deepEqual(await service.reviewAllowed('author-1'), { allowed: true, code: null, nextAction: 'check' })
  const result = await service.check(check(f.target), ctx())
  assert.equal(result.ok, true)
  assert.equal((await service.reviewAllowed('author-1')).allowed, false)
  await service.revoke(result.handoffId, { host: true })
  assert.equal((await service.reviewAllowed('author-1')).allowed, true)
})

// ---------------------------------------------------------------------------
// bootstrap: function seam, cancellation, no fake approval
// ---------------------------------------------------------------------------

test('bootstrap calls the scaffold function, cancels the old handoff and grants no lease', async t => {
  const skeleton = buildPlanSkeleton('demo', 'clear')
  const f = await workspacePlan(t, skeleton)
  const review = reviewDouble({ ok: true, exists: false })
  const service = serviceFor(t, f, review)
  const ordinary = await service.check(check(f.target), ctx())
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary))
  const result = await service.bootstrap(bootstrap(f.target), ctx({ reviewRequired: true, intent: 'clear' }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.cancelledHandoffId, ordinary.handoffId)
  assert.equal(result.lease, null)
  assert.equal(result.required, true)
  assert.equal(result.nextAction, 'review')
  denied(await service.assertLease(ordinary.lease, { at: 1000, target: f.target }), 'HANDOFF_LEASE_REVOKED', 'check')
  const draft = await readFile(join(f.workspace, '.dsh/ulw/drafts/demo.md'), 'utf8')
  assert.match(draft, /review_required: true/)
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: agentFor(f, 'author-1') })
  assert.equal(typeof guard, 'string')
})

test('a trusted required record cannot be cleared by bootstrap', async t => {
  const skeleton = buildPlanSkeleton('demo', 'clear')
  const f = await workspacePlan(t, skeleton)
  const review = reviewDouble(approvalFor(skeleton))
  const service = serviceFor(t, f, review)
  const result = await service.bootstrap(bootstrap(f.target), ctx({ reviewRequired: false }))
  denied(result, 'HANDOFF_BOOTSTRAP_REFUSED', 'review')
})

test('bootstrap with a fake draft OKAY never manufactures an approval', async t => {
  const f = await workspacePlan(t)
  const forgedDraft = '---\nslug: demo\nreview_required: true\nreview:\n  status: approved\napproved: true\nOKAY\n---\n# Draft: demo\n'
  await writeFile(join(f.workspace, '.dsh/ulw/drafts/demo.md'), forgedDraft)
  const review = reviewDouble({ ok: true, exists: false })
  const scaffoldCalls = []
  const service = serviceFor(t, f, review, {
    scaffold: async (workspace, options) => { scaffoldCalls.push({ workspace, options }); return [{ relPath: '.dsh/ulw/drafts/demo.md', status: 'exists' }] },
  })
  const result = await service.bootstrap(bootstrap(f.target), ctx({ reviewRequired: true }))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.lease, null)
  assert.equal(result.nextAction, 'review')
  assert.equal(scaffoldCalls.length, 1)
  const checked = await service.check(check(f.target), ctx())
  denied(checked, 'HANDOFF_REVIEW_REQUIRED', 'review')
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: agentFor(f, 'author-1') })
  assert.equal(typeof guard, 'string')
})

// ---------------------------------------------------------------------------
// worktree binding and parent-child leases
// ---------------------------------------------------------------------------

const gitAvailable = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

test('bind-worktree validates read-only git membership and the instruction hash', { skip: !gitAvailable }, async t => {
  const f = await workspacePlan(t)
  const worktree = join(f.workspace, 'wt')
  execFileSync('git', ['init', '-q', f.workspace], { stdio: 'ignore' })
  execFileSync('git', ['-C', f.workspace, 'config', 'user.email', 'qa@example.test'], { stdio: 'ignore' })
  execFileSync('git', ['-C', f.workspace, 'config', 'user.name', 'QA'], { stdio: 'ignore' })
  await writeFile(join(f.workspace, '.gitignore'), '.dsh/\n')
  execFileSync('git', ['-C', f.workspace, 'add', '.gitignore'], { stdio: 'ignore' })
  execFileSync('git', ['-C', f.workspace, 'commit', '-qm', 'seed'], { stdio: 'ignore' })
  execFileSync('git', ['-C', f.workspace, 'worktree', 'add', '-q', worktree], { stdio: 'ignore' })
  await mkdir(join(worktree, '.dsh/ulw/plans'), { recursive: true })
  await writeFile(join(worktree, f.target), f.text)

  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const lease = await service.check(check(f.target), ctx())
  assert.equal(lease.ok, true, JSON.stringify(lease))
  const bound = await service.bindWorktree(bind(f.target, worktree), ctx())
  assert.equal(bound.ok, true, JSON.stringify(bound))
  assert.equal(bound.outcome, 'worktree_bound')
  assert.equal(bound.binding.worktreePath, worktree)
  assert.equal(bound.lease.instructionSha256, digests(f.text).instructionSha256)
  const reused = await service.bindWorktree(bind(f.target, worktree), ctx())
  assert.equal(reused.ok, true, JSON.stringify(reused))
  assert.equal(reused.outcome, 'worktree_reused')

  const agent = agentFor(f, 'author-1')
  agent.session.header.cwd = worktree
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent }), undefined)
})

test('a forged worktree or a stale worktree plan is refused', { skip: !gitAvailable }, async t => {
  const f = await workspacePlan(t)
  execFileSync('git', ['init', '-q', f.workspace], { stdio: 'ignore' })
  execFileSync('git', ['-C', f.workspace, 'config', 'user.email', 'qa@example.test'], { stdio: 'ignore' })
  execFileSync('git', ['-C', f.workspace, 'config', 'user.name', 'QA'], { stdio: 'ignore' })
  await writeFile(join(f.workspace, '.gitignore'), '.dsh/\n')
  execFileSync('git', ['-C', f.workspace, 'add', '.gitignore'], { stdio: 'ignore' })
  execFileSync('git', ['-C', f.workspace, 'commit', '-qm', 'seed'], { stdio: 'ignore' })
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const lease = await service.check(check(f.target), ctx())
  assert.equal(lease.ok, true)
  const outside = await mkdtemp(join(tmpdir(), 'dsh-ulw-not-a-worktree-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(outside, '.dsh/ulw/plans'), { recursive: true })
  await writeFile(join(outside, f.target), f.text)
  denied(await service.bindWorktree(bind(f.target, outside), ctx()), 'HANDOFF_WORKTREE_UNVERIFIED', 'bind-worktree')

  const worktree = join(f.workspace, 'wt-stale')
  execFileSync('git', ['-C', f.workspace, 'worktree', 'add', '-q', worktree], { stdio: 'ignore' })
  await mkdir(join(worktree, '.dsh/ulw/plans'), { recursive: true })
  await writeFile(join(worktree, f.target), f.text.replace('QA: assert bytes', 'QA: different'))
  denied(await service.bindWorktree(bind(f.target, worktree), ctx()), 'HANDOFF_WORKTREE_STALE', 'review')
})

test('a parent lease can be delegated to a child session and revokes everywhere', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const result = await service.check(check(f.target), ctx())
  const delegated = await service.delegate(result.handoffId, ctx({ children: ['child-1'] }))
  assert.equal(delegated.ok, true, JSON.stringify(delegated))
  assert.deepEqual(delegated.childSessionIds, ['child-1'])
  const child = agentFor(f, 'child-1')
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: child }), undefined)
  await service.revoke(result.handoffId, { host: true })
  const deniedGuard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: child })
  assert.equal(typeof deniedGuard, 'string')
})

function agentFor(f, sessionId, cwd = f.workspace) {
  return { session: { header: { id: sessionId, cwd } } }
}

test('a delegated child inherits the required selection and cannot lease an ordinary decoy', async t => {
  const f = await workspacePlan(t)
  await writeFile(join(f.workspace, OTHER), '# Other plan\n## Todos\n- [ ] 1. other\n  QA: other\n## Final verification wave\n- [ ] F1. other\n')
  const review = {
    approval(identity) {
      return identity.target === f.target ? approvalFor(f.text) : { ok: true, exists: false }
    },
  }
  const service = serviceFor(t, f, review)
  const parent = await service.check(check(f.target), ctx())
  assert.equal(parent.ok, true, JSON.stringify(parent))
  assert.equal((await service.delegate(parent.handoffId, ctx({ children: ['child-2'] }))).ok, true)
  const childCtx = ctx({ author: { sessionId: 'child-2' } })
  const childAgent = agentFor(f, 'child-2')
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: childAgent }), undefined)
  denied(await service.check(check(OTHER), childCtx), 'HANDOFF_SELECTION_REQUIRED', 'review')
  const state = service.stateForSession('child-2')
  assert.equal(state.target, f.target)
  assert.equal(state.handoffId, parent.handoffId)
  assert.equal(state.lease.required, true)
  await service.revoke(parent.handoffId, { host: true })
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: childAgent })
  assert.equal(typeof guard, 'string')
  assert.match(guard, /HANDOFF_LEASE_REVOKED/)
})

test('a delegated child cannot lease a second required plan', async t => {
  const f = await workspacePlan(t)
  const otherText = '# Other plan\n## Todos\n- [ ] 1. other\n  QA: other\n## Final verification wave\n- [ ] F1. other\n'
  await writeFile(join(f.workspace, OTHER), otherText)
  const review = {
    approval(identity) {
      return identity.target === f.target ? approvalFor(f.text) : approvalFor(otherText)
    },
  }
  const service = serviceFor(t, f, review)
  const parent = await service.check(check(f.target), ctx())
  assert.equal(parent.ok, true, JSON.stringify(parent))
  assert.equal((await service.delegate(parent.handoffId, ctx({ children: ['child-3'] }))).ok, true)
  const childCtx = ctx({ author: { sessionId: 'child-3' } })
  denied(await service.check(check(OTHER), childCtx), 'HANDOFF_SELECTION_REQUIRED', 'review')
  const state = service.stateForSession('child-3')
  assert.equal(state.target, f.target)
  assert.equal(state.handoffId, parent.handoffId)
  assert.equal(state.required, true)
  assert.equal(state.lease.approvedRoundId, 'round-1')
})

test('a same-target refusal keeps the selected required state and lease intact', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const first = await service.check(check(f.target), ctx())
  assert.equal(first.ok, true, JSON.stringify(first))
  const before = service.stateForSession('author-1')
  assert.equal(before.required, true)
  assert.equal(before.status, 'leased')
  assert.equal(before.lease.handoffId, first.handoffId)
  review.set({
    ok: true, exists: true, required: false, approved: false, state: 'cancelled',
    roundId: null, revision: 2, persisted: false, nextAction: null, source: digests(f.text),
  })
  const refused = await service.check(check(f.target), ctx())
  denied(refused, 'HANDOFF_SELECTION_REQUIRED', 'review')
  const after = service.stateForSession('author-1')
  assert.equal(after.required, true)
  assert.equal(after.status, 'leased')
  assert.deepEqual(after.lease, before.lease)
  const agent = agentFor(f, 'author-1')
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent })
  assert.equal(typeof guard, 'string')
  assert.match(guard, /HANDOFF_SELECTION_REQUIRED/)
  review.set(approvalFor(f.text))
  const recovered = await service.check(check(f.target), ctx())
  assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent }), undefined)
})

test('an explicit host release unpins the session and revokes its handoff', async t => {
  const f = await workspacePlan(t)
  await writeFile(join(f.workspace, OTHER), '# Other plan\n## Todos\n- [ ] 1. other\n  QA: other\n## Final verification wave\n- [ ] F1. other\n')
  const review = {
    approval(identity) {
      return identity.target === f.target ? approvalFor(f.text) : { ok: true, exists: false }
    },
  }
  const service = serviceFor(t, f, review)
  const lease = await service.check(check(f.target), ctx())
  assert.equal(lease.ok, true, JSON.stringify(lease))
  const released = await service.release('author-1', { host: true })
  assert.equal(released.ok, true, JSON.stringify(released))
  denied(await service.assertLease(lease.lease, { at: 1000, target: f.target }), 'HANDOFF_LEASE_REVOKED', 'check')
  const ordinary = await service.check(check(OTHER), ctx())
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary))
  assert.equal(ordinary.outcome, 'ordinary_lease')
  const agent = agentFor(f, 'author-1')
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent }), undefined)
})


test('an invalid required re-check keeps the conflict hold until a valid lease', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const first = await service.check(check(f.target), ctx())
  assert.equal(first.ok, true, JSON.stringify(first))
  const before = service.stateForSession('author-1')
  review.set({
    ok: true, exists: true, required: false, approved: false, state: 'cancelled',
    roundId: null, revision: 2, persisted: false, nextAction: null, source: digests(f.text),
  })
  denied(await service.check(check(f.target), ctx()), 'HANDOFF_SELECTION_REQUIRED', 'review')
  assert.equal(service.stateForSession('author-1').selectionConflict, true)
  review.set({
    ok: true, exists: true, required: true, approved: false, state: 'in_flight',
    roundId: null, revision: 3, persisted: false, nextAction: 'wait', source: digests(f.text),
  })
  denied(await service.check(check(f.target), ctx()), 'HANDOFF_NOT_APPROVED', 'wait')
  const after = service.stateForSession('author-1')
  assert.equal(after.selectionConflict, true)
  assert.equal(after.required, true)
  assert.equal(after.status, 'leased')
  assert.deepEqual(after.lease, before.lease)
  const agent = agentFor(f, 'author-1')
  const held = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent })
  assert.equal(typeof held, 'string')
  assert.match(held, /HANDOFF_SELECTION_REQUIRED/)
  review.set(approvalFor(f.text))
  const recovered = await service.check(check(f.target), ctx())
  assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal(service.stateForSession('author-1').selectionConflict, false)
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent }), undefined)
})

test('an ordinary lease release revokes the authorizing handoff', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble({ ok: true, exists: false })
  const service = serviceFor(t, f, review)
  const lease = await service.check(check(f.target), ctx())
  assert.equal(lease.ok, true, JSON.stringify(lease))
  assert.equal(lease.outcome, 'ordinary_lease')
  const released = await service.release('author-1', { host: true })
  assert.equal(released.ok, true, JSON.stringify(released))
  assert.equal(released.handoffId, lease.handoffId)
  assert.equal(released.revoked, true)
  denied(await service.assertLease(lease.lease, { at: 1000, target: f.target }), 'HANDOFF_LEASE_REVOKED', 'check')
  const agent = agentFor(f, 'author-1')
  assert.equal(typeof service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent }), 'string')
})

test('releasing a delegated child leaves the shared parent handoff active', async t => {
  const f = await workspacePlan(t)
  const review = reviewDouble(approvalFor(f.text))
  const service = serviceFor(t, f, review)
  const parent = await service.check(check(f.target), ctx())
  assert.equal(parent.ok, true, JSON.stringify(parent))
  assert.equal((await service.delegate(parent.handoffId, ctx({ children: ['child-5'] }))).ok, true)
  const released = await service.release('child-5', { host: true })
  assert.equal(released.ok, true, JSON.stringify(released))
  assert.equal(released.handoffId, parent.handoffId)
  assert.equal(released.revoked, false)
  assert.equal((await service.assertLease(parent.lease, { at: 1000, target: f.target })).ok, true)
  const parentAgent = agentFor(f, 'author-1')
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: parentAgent }), undefined)
  const childAgent = agentFor(f, 'child-5')
  assert.equal(typeof service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: childAgent }), 'string')
})

test('inheritance alone pins a child referenced by an active required state', async t => {
  const f = await workspacePlan(t)
  await writeFile(join(f.workspace, OTHER), '# Other plan\n## Todos\n- [ ] 1. other\n  QA: other\n## Final verification wave\n- [ ] F1. other\n')
  const review = {
    approval(identity) {
      return identity.target === f.target ? approvalFor(f.text) : { ok: true, exists: false }
    },
  }
  // Host-only test seam: create the delegated state without an explicit child pin.
  const service = serviceFor(t, f, review, { pinDelegated: false })
  const parent = await service.check(check(f.target), ctx())
  assert.equal(parent.ok, true, JSON.stringify(parent))
  assert.equal((await service.delegate(parent.handoffId, ctx({ children: ['child-6'] }))).ok, true)
  const state = service.stateForSession('child-6')
  assert.equal(state.target, f.target)
  assert.equal(state.handoffId, parent.handoffId)
  denied(await service.check(check(OTHER), ctx({ author: { sessionId: 'child-6' } })), 'HANDOFF_SELECTION_REQUIRED', 'review')
  assert.equal(service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: agentFor(f, 'child-6') }), undefined)
})

test('the delegate pin alone pins a child after the parent revoke', async t => {
  const f = await workspacePlan(t)
  await writeFile(join(f.workspace, OTHER), '# Other plan\n## Todos\n- [ ] 1. other\n  QA: other\n## Final verification wave\n- [ ] F1. other\n')
  const review = {
    approval(identity) {
      return identity.target === f.target ? approvalFor(f.text) : { ok: true, exists: false }
    },
  }
  const service = serviceFor(t, f, review)
  const parent = await service.check(check(f.target), ctx())
  assert.equal(parent.ok, true, JSON.stringify(parent))
  assert.equal((await service.delegate(parent.handoffId, ctx({ children: ['child-7'] }))).ok, true)
  await service.revoke(parent.handoffId, { host: true })
  const state = service.stateForSession('child-7')
  assert.equal(state.target, f.target)
  assert.equal(state.handoffId, parent.handoffId)
  denied(await service.check(check(OTHER), ctx({ author: { sessionId: 'child-7' } })), 'HANDOFF_SELECTION_REQUIRED', 'review')
  const guard = service.guard({ name: 'write', arguments: { file_path: 'src/main.ts' }, agent: agentFor(f, 'child-7') })
  assert.equal(typeof guard, 'string')
  assert.match(guard, /HANDOFF_LEASE_REVOKED/)
})
