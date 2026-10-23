/**
 * The plan-state command's contract: row parsing, status counting, one-byte ticks,
 * and ledger validation. Pure helpers only - the CLI is exercised by manual QA.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyTick,
  formatStatus,
  parseRows,
  PlanStateError,
  READ_CAP_BYTES,
  summarize,
  validateLedgerEntry,
} from '../skills/ulw-execute/scripts/plan-state.mjs'

function validInput(overrides = {}) {
  return {
    event: 'task-completed',
    plan: '.dsh/ulw/plans/state-safety.md',
    task: '1',
    sessionId: 'dsh:qa-session',
    commands: ['node --test'],
    artifact: ['/evidence/task-1-cli.txt'],
    adversarial: ['malformed_input=exit code 2'],
    cleanup: ['rm -rf scratch'],
    attempt: '1',
    checkpointOpenedAt: '2026-10-24T00:00:00Z',
    ...overrides,
  }
}

const exitCodeIs = (code) => (err) => err instanceof PlanStateError && err.exitCode === code

test('parseRows captures column-zero rows with id, status, and line', () => {
  const plan = '# Plan\n\n- [ ] 1. first\n- [x] 2. second\n- [~] F3. third\n'
  assert.deepEqual(parseRows(plan), [
    { id: '1', status: ' ', line: 3 },
    { id: '2', status: 'x', line: 4 },
    { id: 'F3', status: '~', line: 5 },
  ])
})

test('parseRows ignores indented and nested checkboxes', () => {
  const plan = '  - [ ] 1. indented\n\t- [x] 2. tabbed\n> - [ ] 3. quoted\n- [ ] 4. real\n'
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['4'])
})

test('parseRows returns an empty list for an empty plan', () => {
  assert.deepEqual(parseRows(''), [])
  assert.deepEqual(parseRows(Buffer.alloc(0)), [])
})

test('summarize counts statuses and picks the first open row', () => {
  const plan = '- [x] 1. done\n- [~] 2. blocked\n- [ ] 3. open\n- [ ] 4. later\n'
  assert.deepEqual(summarize(plan), { total: 4, done: 1, open: 2, blocked: 1, next: '3', line: 3 })
})

test('summarize reports a dash when every row is closed', () => {
  const plan = '- [x] 1. done\n- [~] 2. blocked\n'
  assert.deepEqual(summarize(plan), { total: 2, done: 1, open: 0, blocked: 1, next: '-', line: '-' })
})

test('formatStatus reports capped=no at exactly the 51200-byte boundary', () => {
  assert.equal(READ_CAP_BYTES, 51200)
  const record = { plan: 'plan.md', bytes: 51200, total: 0, done: 0, open: 0, blocked: 0, next: '-', line: '-' }
  assert.equal(
    formatStatus(record),
    'plan=plan.md bytes=51200 capped=no total=0 done=0 open=0 blocked=0 next=- line=-',
  )
})

test('formatStatus reports capped=yes one byte over the boundary', () => {
  const record = { plan: 'plan.md', bytes: 51201, total: 0, done: 0, open: 0, blocked: 0, next: '-', line: '-' }
  assert.equal(
    formatStatus(record),
    'plan=plan.md bytes=51201 capped=yes total=0 done=0 open=0 blocked=0 next=- line=-',
  )
})

test('applyTick changes exactly the target status byte', () => {
  const before = '- [ ] 1. first\n- [ ] 2. second\n'
  const original = Buffer.from(before)
  const result = applyTick(before, '2')
  const differences = []
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] !== result.content[index]) differences.push(index)
  }
  assert.equal(result.changed, true)
  assert.deepEqual(differences, [result.offset])
  assert.equal(result.content.toString('utf8'), '- [ ] 1. first\n- [x] 2. second\n')
})

test('applyTick is idempotent when the row already has the target status', () => {
  const plan = '- [x] 1. done\n'
  const result = applyTick(plan, '1')
  assert.equal(result.changed, false)
  assert.equal(result.content.toString('utf8'), plan)
})

test('applyTick raises exit 2 for a missing row and leaves the bytes untouched', () => {
  const plan = Buffer.from('- [ ] 1. one\n')
  assert.throws(() => applyTick(plan, '999'), exitCodeIs(2))
  assert.equal(plan.toString('utf8'), '- [ ] 1. one\n')
})

test('applyTick raises exit 3 for a duplicate row id', () => {
  const plan = '- [ ] 7. first\n- [x] 7. second\n'
  assert.throws(() => applyTick(plan, '7'), exitCodeIs(3))
})

test('applyTick flips a row to the blocked state', () => {
  const result = applyTick('- [ ] 4. four\n', '4', '~')
  assert.equal(result.changed, true)
  assert.equal(result.content.toString('utf8'), '- [~] 4. four\n')
})

test('applyTick rejects a target status other than x or ~', () => {
  assert.throws(() => applyTick('- [ ] 1. one\n', '1', '?'), exitCodeIs(5))
})

test('applyTick matches ids verbatim, so 3 never matches 03 or F3', () => {
  const plan = '- [ ] 03. zero padded\n- [ ] F3. final wave\n'
  assert.throws(() => applyTick(plan, '3'), exitCodeIs(2))
  assert.equal(applyTick(plan, '03').changed, true)
  assert.equal(applyTick(plan, 'F3').changed, true)
})

test('applyTick preserves every CRLF byte', () => {
  const before = '- [ ] 1. one\r\n- [ ] 2. two\r\n'
  const result = applyTick(before, '2')
  assert.equal(result.content.toString('utf8'), '- [ ] 1. one\r\n- [x] 2. two\r\n')
  assert.equal((result.content.toString('utf8').match(/\r\n/g) || []).length, 2)
  assert.equal(result.content.length, Buffer.byteLength(before))
})

test('applyTick preserves multi-byte UTF-8 bytes around the row', () => {
  const before = '# 计划\n\n- [ ] 1. 第一项\n'
  const original = Buffer.from(before)
  const result = applyTick(before, '1')
  const expected = Buffer.from('# 计划\n\n- [x] 1. 第一项\n')
  const differences = []
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] !== result.content[index]) differences.push(index)
  }
  assert.equal(result.changed, true)
  assert.ok(result.content.equals(expected))
  assert.equal(differences.length, 1)
})

test('validateLedgerEntry normalizes a valid entry', () => {
  const entry = validateLedgerEntry(validInput())
  assert.equal(entry.event, 'task-completed')
  assert.equal(entry.plan, '.dsh/ulw/plans/state-safety.md')
  assert.equal(entry.task, '1')
  assert.equal(entry.session_id, 'dsh:qa-session')
  assert.equal(entry.attempt, 1)
  assert.equal(entry.checkpoint_opened_at, '2026-10-24T00:00:00Z')
  assert.deepEqual(entry.commands, ['node --test'])
  assert.deepEqual(entry.artifact, ['/evidence/task-1-cli.txt'])
  assert.deepEqual(entry.adversarial_classes, [
    { class: 'malformed_input', result: 'exit code 2' },
  ])
})

test('validateLedgerEntry keeps flat extra keys', () => {
  const entry = validateLedgerEntry(validInput({ extra: '{"verdict":"confirmed","attempts":2}' }))
  assert.equal(entry.verdict, 'confirmed')
  assert.equal(entry.attempts, 2)
})

test('validateLedgerEntry rejects a missing required field', () => {
  const input = validInput()
  delete input.cleanup
  assert.throws(() => validateLedgerEntry(input), exitCodeIs(5))
})

test('validateLedgerEntry rejects a session id without a dsh/codex prefix', () => {
  assert.throws(() => validateLedgerEntry(validInput({ sessionId: 'qa-session' })), exitCodeIs(5))
})

test('validateLedgerEntry rejects a malformed adversarial token', () => {
  assert.throws(() => validateLedgerEntry(validInput({ adversarial: ['not-a-token'] })), exitCodeIs(5))
})

test('validateLedgerEntry rejects an empty adversarial list', () => {
  assert.throws(() => validateLedgerEntry(validInput({ adversarial: [] })), exitCodeIs(5))
})

test('validateLedgerEntry rejects an array as extra', () => {
  assert.throws(() => validateLedgerEntry(validInput({ extra: '[]' })), exitCodeIs(5))
})

test('validateLedgerEntry rejects a primitive as extra', () => {
  assert.throws(() => validateLedgerEntry(validInput({ extra: '42' })), exitCodeIs(5))
})

test('validateLedgerEntry rejects a nested value in extra', () => {
  assert.throws(() => validateLedgerEntry(validInput({ extra: '{"nested":{"a":1}}' })), exitCodeIs(5))
})

test('validateLedgerEntry rejects extra keys that override mandated fields', () => {
  assert.throws(() => validateLedgerEntry(validInput({ extra: '{"task":"other"}' })), exitCodeIs(5))
})

test('validateLedgerEntry rejects a non-positive attempt', () => {
  assert.throws(() => validateLedgerEntry(validInput({ attempt: '0' })), exitCodeIs(5))
  assert.throws(() => validateLedgerEntry(validInput({ attempt: '1.5' })), exitCodeIs(5))
})

test('validateLedgerEntry rejects an unparseable checkpoint timestamp', () => {
  assert.throws(() => validateLedgerEntry(validInput({ checkpointOpenedAt: 'yesterday' })), exitCodeIs(5))
})
