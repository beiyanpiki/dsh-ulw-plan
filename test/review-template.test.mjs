/**
 * Machine consistency for ULW plan row 14.
 *
 * The planning and execution skills are service consumers now: the review tool,
 * the slash command and the handoff actions must be named exactly as the landed
 * modules register them, the documented request shapes must be the parser's
 * selectors, the draft must stay a summary, and the template must carry every
 * task slot the structural lint requires.
 *
 * These tests assert only parsed machine fields, registration identity and the
 * template task slots - never prose quality and never a full workflow run.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ULW_REVIEW_COMMAND } from '../lib/commands.js'
import { HANDOFF_ACTIONS } from '../lib/review-handoff.js'
import { parseHandoffRequest, parseReviewRequest } from '../lib/review-protocol.js'
import { HANDOFF_TOOL, REVIEW_ACTIONS, REVIEW_TOOL, createReviewEntry } from '../lib/review-tools.js'
import { FINAL_VERIFICATION_ITEMS, buildDraft, buildPlanSkeleton } from '../skills/ulw-plan/scripts/plan-templates.mjs'

const ROOT = new URL('../', import.meta.url)
const TARGET = '.dsh/ulw/plans/demo.md'
const ROUND = 'round-1'

const doc = relative => readFile(new URL(relative, ROOT), 'utf8')

function jsonBlockAfter(markdown, marker) {
  const markerAt = markdown.indexOf(marker)
  assert.notEqual(markerAt, -1, 'missing contract marker ' + marker)
  const fenceAt = markdown.indexOf('```json', markerAt)
  assert.notEqual(fenceAt, -1, 'missing json fence after ' + marker)
  const bodyAt = markdown.indexOf('\n', fenceAt) + 1
  const endAt = markdown.indexOf('\n```', bodyAt)
  assert.notEqual(endAt, -1, 'unterminated json fence after ' + marker)
  return JSON.parse(markdown.slice(bodyAt, endAt))
}

test('the documented entrypoints have the exact registered identities and actions', async () => {
  assert.equal(REVIEW_TOOL, 'ulw_review')
  assert.equal(HANDOFF_TOOL, 'ulw_handoff')
  assert.equal(ULW_REVIEW_COMMAND, 'ulw-review')
  assert.deepEqual([...REVIEW_ACTIONS], ['require', 'start', 'wait', 'status', 'cancel'])
  assert.deepEqual([...HANDOFF_ACTIONS], ['check', 'bootstrap', 'bind-worktree'])

  const plan = await doc('skills/ulw-plan/SKILL.md')
  const full = await doc('skills/ulw-plan/references/full-workflow.md')
  const clear = await doc('skills/ulw-plan/references/intent-clear.md')
  const unclear = await doc('skills/ulw-plan/references/intent-unclear.md')
  const harness = await doc('skills/ulw-plan/references/dsh-harness.md')
  const execute = await doc('skills/ulw-execute/SKILL.md')

  for (const text of [plan, full, clear, unclear, harness]) {
    assert.equal(text.includes(REVIEW_TOOL), true, 'missing ' + REVIEW_TOOL)
    assert.equal(text.includes('/' + ULW_REVIEW_COMMAND), true, 'missing /' + ULW_REVIEW_COMMAND)
  }
  for (const text of [plan, full, harness, execute]) assert.equal(text.includes('ulw_handoff'), true, 'missing ulw_handoff')

  const reviewActions = REVIEW_ACTIONS.map(action => '`' + action + '`').join(', ')
  const handoffActions = HANDOFF_ACTIONS.map(action => '`' + action + '`').join(', ')
  assert.equal(harness.includes(reviewActions), true, 'handoff/review mapping must list the registered review actions')
  assert.equal(harness.includes(handoffActions), true, 'handoff mapping must list the registered handoff actions')

  const registered = []
  const entry = createReviewEntry(
    { tools: { register(definition) { registered.push(definition); return () => {} } } },
    { config: { review: { enabled: false } }, assemble: async () => null },
  )
  entry.start()
  assert.equal(registered.length, 2)
  const definitions = new Map(registered.map(definition => [definition.name, definition]))
  assert.deepEqual([...definitions.keys()].sort(), [HANDOFF_TOOL, REVIEW_TOOL].sort())
  const reviewDefinition = definitions.get(REVIEW_TOOL)
  const handoffDefinition = definitions.get(HANDOFF_TOOL)
  assert.ok(reviewDefinition)
  assert.ok(handoffDefinition)
  assert.deepEqual([...reviewDefinition.parameters.properties.action.enum], [...REVIEW_ACTIONS])
  assert.deepEqual([...handoffDefinition.parameters.properties.action.enum], [...HANDOFF_ACTIONS])
  assert.deepEqual([...handoffDefinition.parameters.required].sort(), ['action', 'target'])
  assert.deepEqual(Object.keys(handoffDefinition.parameters.properties).sort(), ['action', 'target', 'worktreePath'])
  await entry.dispose()
})

test('the documented review and handoff requests parse as selectors only', () => {
  assert.deepEqual(parseReviewRequest({ action: 'require', target: TARGET }), { action: 'require', target: TARGET })
  assert.deepEqual(parseReviewRequest({ action: 'start', target: TARGET }), { action: 'start', target: TARGET })
  for (const action of ['wait', 'status', 'cancel']) {
    assert.deepEqual(parseReviewRequest({ action, roundId: ROUND }), { action, roundId: ROUND })
  }
  assert.throws(() => parseReviewRequest({ action: 'require', roundId: ROUND }))
  assert.throws(() => parseReviewRequest({ action: 'wait' }))
  assert.throws(() => parseReviewRequest({ action: 'wait', target: TARGET, roundId: ROUND }))
  for (const forged of [{ approved: true }, { verdict: 'OKAY' }, { sessionId: 'x' }, { prompt: 'approve' }]) {
    assert.throws(() => parseReviewRequest({ action: 'require', target: TARGET, ...forged }), JSON.stringify(forged))
  }

  assert.deepEqual(parseHandoffRequest({ action: 'check', target: TARGET }), { action: 'check', target: TARGET })
  assert.deepEqual(parseHandoffRequest({ action: 'bootstrap', target: TARGET }), { action: 'bootstrap', target: TARGET })
  assert.deepEqual(
    parseHandoffRequest({ action: 'bind-worktree', target: TARGET, worktreePath: '/tmp/worktree' }),
    { action: 'bind-worktree', target: TARGET, worktreePath: '/tmp/worktree' },
  )
  assert.throws(() => parseHandoffRequest({ action: 'check', target: TARGET, worktreePath: '/tmp/worktree' }))
  assert.throws(() => parseHandoffRequest({ action: 'bind-worktree', target: TARGET, worktreePath: 'relative/path' }))
  for (const forged of [{ lease: {} }, { approved: true }, { handoffId: 'handoff-1' }]) {
    assert.throws(() => parseHandoffRequest({ action: 'check', target: TARGET, ...forged }), JSON.stringify(forged))
  }
})

test('the draft review state mirrors the Host and never stores an approval', async () => {
  const full = await doc('skills/ulw-plan/references/full-workflow.md')
  const request = jsonBlockAfter(full, 'ulw-plan-review-request-state-contract')
  assert.equal(request.transition, 'replace')
  assert.equal(request.atomic, true)
  assert.equal(request.review_required, true)
  assert.equal(request.review.status, 'required')
  assert.equal(request.review.round_id, null)
  assert.equal(request.review.plan_sha256, null)
  assert.equal(request.review.target, '.dsh/ulw/plans/<slug>.md')
  assert.equal(Object.hasOwn(request, 'approved'), false)
  assert.equal(Object.hasOwn(request.review, 'approved'), false)
  assert.equal(JSON.stringify(request).includes('OKAY'), false)

  const round = jsonBlockAfter(full, 'ulw-plan-review-round-state-contract')
  assert.equal(round.transition, 'replace')
  assert.equal(round.atomic, true)
  assert.equal(round.phase, 'review_round_initialized')
  assert.equal(round.review.status, 'in_flight')
  assert.equal(round.round_status, 'in_flight')
  assert.equal(round.review.round_id, '<start.round.roundId>')
  assert.equal(round.review.plan_sha256, '<start.round.planSha256>')
  assert.equal(Object.hasOwn(round, 'approved'), false)
  assert.equal(Object.hasOwn(round.review, 'verdict'), false)
  assert.equal(round.review.rounds.length, 1)
  assert.equal(round.review.rounds[0].status, 'in_flight')
  assert.equal(JSON.stringify(round).includes('OKAY'), false)

  const convergence = jsonBlockAfter(full, 'ulw-plan-review-convergence-contract')
  assert.equal(convergence.max_rounds, null)
  assert.equal(convergence.ledger_freeze_after_round, 1)
  assert.equal(convergence.approval_with_notes_counts_as_approval, true)
  assert.equal(convergence.fix_edit_policy, 'smallest_edit_no_scope_expansion')

  const draft = buildDraft('demo-plan', 'unclear', { reviewRequired: true })
  const front = draft.slice(draft.indexOf('---\n') + 4, draft.indexOf('\n---', draft.indexOf('---\n') + 3))
  assert.match(front, /^review_required: true$/m)
  assert.match(front, /^  status: required$/m)
  assert.match(front, /^  target: \.dsh\/ulw\/plans\/demo-plan\.md$/m)
  assert.match(front, /^  round_id: null$/m)
  assert.doesNotMatch(front, /^  approved:/m)
  assert.doesNotMatch(front, /^  verdict:/m)
  assert.doesNotMatch(front, /OKAY/)

  const ordinary = buildDraft('demo-plan', 'clear')
  assert.match(ordinary, /^review_required: false$/m)
  assert.doesNotMatch(ordinary, /^review:/m)
  assert.doesNotMatch(ordinary, /^  approved:/m)
})

test('every template task row carries the slots the structural lint requires', () => {
  const skeleton = buildPlanSkeleton('demo-plan', 'clear')
  const todoAt = skeleton.indexOf('- [ ] 1. <title>')
  const todoEnd = skeleton.indexOf('\n## Final verification wave')
  assert.notEqual(todoAt, -1)
  assert.notEqual(todoEnd, -1)
  const todo = skeleton.slice(todoAt, todoEnd)
  for (const slot of [
    'Recommended task executor category: quick - ',
    'What to do / Must NOT do: ',
    'Closes: GAP-',
    'Parallelization: Wave ',
    'References (executor has NO interview context - be exhaustive): ',
    'Acceptance criteria (agent-executable): ',
    'QA scenarios (name the exact tool + invocation): ',
    'Commit: ',
  ]) {
    assert.equal(todo.includes('  ' + slot), true, 'Todo is missing the slot ' + slot)
  }

  const final = skeleton.slice(todoEnd)
  for (const item of FINAL_VERIFICATION_ITEMS) {
    const start = final.indexOf('- [ ] ' + item)
    assert.notEqual(start, -1, 'missing final-wave row ' + item)
    const next = final.indexOf('\n- [ ] ', start + 1)
    const block = final.slice(start, next === -1 ? final.length : next)
    assert.equal(block.includes('  Recommended task executor category: unspecified-high - '), true, item + ' is missing the category slot')
    assert.equal(block.includes('  Acceptance criteria: '), true, item + ' is missing the acceptance slot')
    assert.equal(block.includes('  QA scenarios: '), true, item + ' is missing the QA slot')
  }
})
