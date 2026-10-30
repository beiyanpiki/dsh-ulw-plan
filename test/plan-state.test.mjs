/**
 * The plan-state command's contract: section-scoped row parsing, status counting,
 * one-byte ticks that refuse concurrent edits, and ledger validation.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applyTick,
  formatStatus,
  parseRows,
  PlanStateError,
  READ_CAP_BYTES,
  summarize,
  validateLedgerEntry,
} from '../skills/ulw-execute/scripts/plan-state.mjs'

const CLI = fileURLToPath(new URL('../skills/ulw-execute/scripts/plan-state.mjs', import.meta.url))

// Test-only read barrier: pause the CLI after its first read of the plan file so a
// concurrent writer can win the race deterministically, then release it via stdin.
const PAUSE_HOOK = `const fs = require('node:fs')
const original = fs.readFileSync
let paused = false
const isPlanRead = (path) => {
  // plan-state reads through one descriptor, so match the fd's identity to the plan.
  if (typeof path === 'number') {
    const read = fs.fstatSync(path)
    const plan = fs.statSync(process.env.PLAN_STATE_BARRIER)
    return read.dev === plan.dev && read.ino === plan.ino
  }
  return String(path) === process.env.PLAN_STATE_BARRIER
}
fs.readFileSync = function (path, ...rest) {
  const result = original.call(this, path, ...rest)
  if (!paused && isPlanRead(path)) {
    paused = true
    process.stderr.write('SNAPSHOT_READY' + String.fromCharCode(10))
    fs.readSync(0, Buffer.alloc(1), 0, 1, null)
  }
  return result
}
require('node:module').syncBuiltinESMExports()
`

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

test('parseRows counts only rows inside the canonical task sections', () => {
  const plan = [
    '# Plan',
    '## Scope',
    '- [ ] 90. prose example outside the task sections',
    '## Todos',
    '- [x] 1. first',
    '- [~] 2. second',
    '- [ ] 3. third',
    '## Commit strategy',
    '- [ ] 91. policy example',
    '## Final verification wave',
    '- [ ] F1. audit',
    '## Notes',
    '- [ ] 92. trailing prose',
    '',
  ].join('\n')
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1', '2', '3', 'F1'])
  assert.deepEqual(summarize(plan), { total: 4, done: 1, open: 2, blocked: 1, next: '3', line: 7 })
  assert.throws(() => applyTick(plan, '90'), exitCodeIs(2))
})

test('parseRows ignores fenced samples, including info strings and nested fences', () => {
  const plan = [
    '## Todos',
    '```md',
    '- [ ] 90. backtick sample',
    '~~~',
    '- [ ] 91. nested tilde sample',
    '~~~',
    '```',
    '~~~md',
    '- [ ] 92. tilde sample',
    '~~~',
    '- [ ] 1. real',
    '## Final verification wave',
    '- [ ] F1. audit',
    '',
  ].join('\n')
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1', 'F1'])
  assert.deepEqual(summarize(plan), { total: 2, done: 0, open: 2, blocked: 0, next: '1', line: 11 })
})

test('parseRows ignores every later row when a fence is never closed', () => {
  const plan = '## Todos\n~~~md\n- [ ] 1. sample\n- [ ] 2. sample\n'
  assert.deepEqual(parseRows(plan), [])
  assert.throws(() => applyTick(plan, '1'), exitCodeIs(2))
  assert.equal(plan, '## Todos\n~~~md\n- [ ] 1. sample\n- [ ] 2. sample\n')
})

test('parseRows ignores checkbox lines inside HTML comments', () => {
  const plan = ['## Todos', '<!-- hidden examples:', '- [ ] 90. hidden', '-->', '- [ ] 1. real', ''].join('\n')
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1'])
  assert.throws(() => applyTick(plan, '90'), exitCodeIs(2))
})

test('parseRows ignores quoted, nested, and indented checkbox lines inside a task section', () => {
  const plan = [
    '## Todos',
    '> - [ ] 90. quoted',
    '  - [ ] 91. nested list',
    '\t- [ ] 92. tabbed',
    '    - [ ] 93. indented code',
    '- [ ] 1. real',
    '',
  ].join('\n')
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1'])
})

test('parseRows keeps flat plans without H2 sections backward compatible', () => {
  const plan = '# Plan\n- [ ] 1. flat one\n- [x] 2. flat two\n'
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1', '2'])
})

test('task section headings match case-insensitively and ignore other H2 sections', () => {
  const plan = ['## TODOS', '- [ ] 1. real', '## notes', '- [ ] 90. ignored', '## final verification WAVE', '- [ ] F1. audit', ''].join('\n')
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1', 'F1'])
})

test('a UTF-8 BOM does not hide the canonical heading on the first line', () => {
  const plan = '\uFEFF## Todos\n- [ ] 1. real\n## Notes\n- [ ] 90. ignored\n'
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1'])
})

test('a BOM-prefixed first-line row is never executable, exactly like review-lint', () => {
  const plan = '\uFEFF- [ ] 1. first\n- [ ] 2. second\n'
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['2'])
  assert.throws(() => applyTick(plan, '1'), exitCodeIs(2))
  const result = applyTick(plan, '2')
  const rowStart = Buffer.byteLength(plan.slice(0, plan.indexOf('- [ ] 2. second')))
  assert.equal(result.offset, rowStart + 3)
  assert.equal(result.content.toString('utf8'), '\uFEFF- [ ] 1. first\n- [x] 2. second\n')
})

test('headings inside fenced blocks do not change the task section', () => {
  const plan = ['## Todos', '```md', '## Commit strategy', '```', '- [ ] 1. still in todos', ''].join('\n')
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1'])
})

test('headings inside HTML comments do not change the task section', () => {
  const plan = '## Todos\n<!--\n## Commit strategy\n-->\n- [ ] 1. still in todos\n'
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1'])
})

test('a duplicate id that exists only in a fence does not make the real row ambiguous', () => {
  const plan = ['## Todos', '~~~md', '- [ ] 1. sample', '~~~', '- [ ] 1. real', '## Final verification wave', '- [ ] F1. audit', ''].join('\n')
  const result = applyTick(plan, '1')
  assert.equal(result.changed, true)
  assert.equal(result.content.toString('utf8'), plan.replace('- [ ] 1. real', '- [x] 1. real'))
})

test('a row id that exists only inside a fence returns exit 2 without mutation', () => {
  const plan = '## Todos\n~~~md\n- [ ] 99. sample\n~~~\n- [ ] 1. real\n'
  assert.throws(() => applyTick(plan, '99'), exitCodeIs(2))
  assert.equal(plan, '## Todos\n~~~md\n- [ ] 99. sample\n~~~\n- [ ] 1. real\n')
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

test('the CLI tick writes exactly one byte in place and preserves mode, inode, CRLF, BOM, and multibyte bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-state-mode-'))
  try {
    const planPath = join(dir, 'plan.md')
    const before = Buffer.from('\uFEFF# Plan\r\n## Todos\r\n- [ ] 1. 第一项\r\n- [ ] 2. second\r\n', 'utf8')
    writeFileSync(planPath, before)
    chmodSync(planPath, 0o640)
    const inode = statSync(planPath).ino
    const first = spawnSync(process.execPath, [CLI, 'tick', planPath, '2'], { encoding: 'utf8' })
    assert.equal(first.status, 0)
    assert.equal(first.stdout, 'ticked 2 x\n')
    assert.equal(first.stderr, '')
    const after = readFileSync(planPath)
    assert.equal(after.length, before.length)
    assert.equal(statSync(planPath).mode & 0o777, 0o640)
    assert.equal(statSync(planPath).ino, inode)
    const differences = []
    for (let index = 0; index < before.length; index += 1) {
      if (before[index] !== after[index]) differences.push(index)
    }
    assert.equal(differences.length, 1)
    assert.equal(after[differences[0]], 'x'.charCodeAt(0))
    assert.equal(differences[0] - 3, before.indexOf('- [ ] 2. second'))
    const second = spawnSync(process.execPath, [CLI, 'tick', planPath, '2'], { encoding: 'utf8' })
    assert.equal(second.status, 0)
    assert.equal(second.stdout, 'already 2 x\n')
    assert.ok(readFileSync(planPath).equals(after))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI refuses a tick that loses the read race and preserves every concurrent byte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-state-race-'))
  let child = null
  try {
    const planPath = join(dir, 'race.md')
    const hookPath = join(dir, 'pause-read.cjs')
    const original = '## Todos\n- [ ] 1. first\n- [ ] 2. second\n'
    const concurrent = original.replace('- [ ] 2.', '- [x] 2.') + 'USER IMPORTANT NEW INSTRUCTIONS\n'
    writeFileSync(planPath, original)
    writeFileSync(hookPath, PAUSE_HOOK)
    let stdout = ''
    let stderr = ''
    let injected = false
    child = spawn(process.execPath, ['--require', hookPath, CLI, 'tick', planPath, '1'], {
      env: { ...process.env, PLAN_STATE_BARRIER: planPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`barrier timed out; stderr=${stderr}`))
      }, 15000)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
        if (!injected && stderr.includes('SNAPSHOT_READY')) {
          injected = true
          try {
            writeFileSync(planPath, concurrent)
          } catch (err) {
            reject(err)
            return
          }
          child.stdin.end('x')
        }
      })
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code })
      })
    })
    assert.equal(injected, true)
    assert.notEqual(result.code, 0, `expected a refusal but the CLI exited 0: ${stdout}${stderr}`)
    assert.equal(stdout, '')
    assert.equal(readFileSync(planPath, 'utf8'), concurrent)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

const CRLF_SAMPLE = [
  '# Plan',
  '',
  '## Todos',
  '```md',
  '- [ ] 90. fenced demo row',
  '```',
  '- [ ] 1. real task',
  '- [~] 2. blocked task',
  '## Final verification wave',
  '- [ ] F1. audit',
  '',
].join('\n')

test('a CRLF plan yields the same sections, fences and selected rows as its LF form', () => {
  const crlf = CRLF_SAMPLE.replace(/\n/g, '\r\n')
  assert.deepEqual(parseRows(crlf), parseRows(CRLF_SAMPLE))
  assert.deepEqual(parseRows(crlf).map(({ id }) => id), ['1', '2', 'F1'])
  assert.deepEqual(summarize(crlf), summarize(CRLF_SAMPLE))
  assert.equal(summarize(crlf).next, '1')
  assert.throws(() => applyTick(crlf, '90'), exitCodeIs(2))
  const result = applyTick(crlf, '1')
  assert.equal(result.changed, true)
  assert.ok(result.content.equals(Buffer.from(crlf.replace('- [ ] 1. real task', '- [x] 1. real task'), 'utf8')))
  assert.equal((result.content.toString('utf8').match(/\r\n/g) || []).length, (crlf.match(/\r\n/g) || []).length)
})

test('a row under a BOM-prefixed heading keeps its byte offset', () => {
  const plan = '\uFEFF## Todos\n- [ ] 1. first\n- [ ] 2. second\n'
  const result = applyTick(plan, '1')
  const rowStart = Buffer.byteLength(plan.slice(0, plan.indexOf('- [ ] 1. first')))
  assert.equal(result.offset, rowStart + 3)
  assert.equal(result.content.toString('utf8'), '\uFEFF## Todos\n- [x] 1. first\n- [ ] 2. second\n')
})

test('frontmatter is metadata, never a task section', () => {
  const plan = [
    '---',
    'title: demo',
    '## Todos',
    '- [ ] 90. frontmatter row',
    '---',
    '## Todos',
    '- [ ] 1. real',
    '## Final verification wave',
    '- [ ] F1. audit',
    '',
  ].join('\n')
  assert.deepEqual(parseRows(plan).map(({ id }) => id), ['1', 'F1'])
  assert.throws(() => applyTick(plan, '90'), exitCodeIs(2))
  assert.deepEqual(parseRows(plan.replace(/\n/g, '\r\n')).map(({ id }) => id), ['1', 'F1'])
  // an unterminated "---" opener is not frontmatter, exactly like review-lint
  const unclosed = '---\n## Todos\n- [ ] 1. real\n'
  assert.deepEqual(parseRows(unclosed).map(({ id }) => id), ['1'])
})

test('the CLI selects only real rows in a CRLF plan with a fenced demo and writes one byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-state-crlf-'))
  try {
    const planPath = join(dir, 'plan.md')
    const before = Buffer.from(CRLF_SAMPLE.replace(/\n/g, '\r\n'), 'utf8')
    writeFileSync(planPath, before)
    chmodSync(planPath, 0o640)
    const inode = statSync(planPath).ino
    const demo = spawnSync(process.execPath, [CLI, 'tick', planPath, '90'], { encoding: 'utf8' })
    assert.equal(demo.status, 2)
    assert.equal(demo.stdout, '')
    assert.match(demo.stderr, /row not found: 90/)
    assert.ok(readFileSync(planPath).equals(before))
    const status = spawnSync(process.execPath, [CLI, 'status', planPath, '--json'], { encoding: 'utf8' })
    assert.equal(status.status, 0)
    const record = JSON.parse(status.stdout)
    assert.equal(record.total, 3)
    assert.equal(record.next, '1')
    assert.equal(record.line, 7)
    const real = spawnSync(process.execPath, [CLI, 'tick', planPath, '1'], { encoding: 'utf8' })
    assert.equal(real.status, 0)
    assert.equal(real.stdout, 'ticked 1 x\n')
    const after = readFileSync(planPath)
    assert.equal(after.length, before.length)
    assert.equal(statSync(planPath).mode & 0o777, 0o640)
    assert.equal(statSync(planPath).ino, inode)
    const differences = []
    for (let index = 0; index < before.length; index += 1) {
      if (before[index] !== after[index]) differences.push(index)
    }
    assert.equal(differences.length, 1)
    assert.equal(after[differences[0]], 'x'.charCodeAt(0))
    assert.equal(differences[0], before.indexOf(Buffer.from('- [ ] 1. real task')) + 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a FIFO plan refuses instead of hanging status and tick', { skip: process.platform === 'win32', timeout: 6000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-state-fifo-'))
  try {
    const fifo = join(dir, 'plan.fifo')
    execFileSync('mkfifo', [fifo])
    const started = Date.now()
    const status = spawnSync(process.execPath, [CLI, 'status', fifo], { encoding: 'utf8', timeout: 3000 })
    assert.equal(status.status, 5)
    assert.match(status.stderr, /regular file/)
    assert.ok(Date.now() - started < 3000)
    const tick = spawnSync(process.execPath, [CLI, 'tick', fifo, '1'], { encoding: 'utf8', timeout: 3000 })
    assert.equal(tick.status, 5)
    assert.match(tick.stderr, /regular file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
