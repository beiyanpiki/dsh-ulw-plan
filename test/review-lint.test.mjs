import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createReviewArtifact, instructionHtmlLines, revalidateReviewArtifact } from '../lib/review-artifact.js'
import { CANONICAL_PLAN_SLUG_RE, ERROR_CODES, PLAN_LINT_CODES, isCanonicalPlanSlug, lintPlan, parsePlanDocument, planSlugFromPath } from '../lib/review-lint.js'
import { parseReviewRequest } from '../lib/review-protocol.js'
import { computeInstructionSha256 } from '../lib/review-artifact.js'
import { applyTick, parseRows } from '../skills/ulw-execute/scripts/plan-state.mjs'

const CLI = fileURLToPath(new URL('../skills/ulw-plan/scripts/plan-lint.mjs', import.meta.url))
const SCAFFOLD = fileURLToPath(new URL('../skills/ulw-plan/scripts/scaffold-plan.mjs', import.meta.url))
const FENCE = '```'
const hash = value => createHash('sha256').update(value).digest('hex')
const lineOf = (content, needle) => {
  const index = content.split('\n').findIndex(line => line.includes(needle))
  assert.ok(index >= 0, 'fixture lost its marker: ' + needle)
  return index + 1
}
const at = (result, code, line) => result.diagnostics.find(d => d.code === code && (line === undefined || d.line === line))
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
const code = value => '`' + value + '`'

// One task row carrying every canonical slot, so a fixture can drop exactly one piece.
const task = (id, { title = 'Task ' + id, category = 'quick — mechanical', body = '演示任务。', refs = code('docs/fidelity.md') + '。', closes = 'GAP-1', acceptance = '  Acceptance criteria: ' + code('node --test') + ' 退出 0。', qa = '  QA scenarios: Happy “passes”。Evidence: ' + code('$E/x.txt') + '。', commit = '  Commit: Y | test(preflight): demo' } = {}) => [
  '- [ ] ' + id + '. ' + title,
  category === null ? null : '  Recommended task executor category: ' + category,
  '  What to do / Must NOT do: ' + body,
  closes === null ? null : '  Closes: ' + closes,
  '  Parallelization: Wave 1 | Blocked by: — | Blocks: —',
  '  References: ' + refs,
  acceptance, qa, commit, '',
].filter(line => line !== null).join('\n')

const VALID_PLAN = [
  '# demo-plan - Work Plan',
  '',
  '## TL;DR (For humans)',
  '**Who this is for:** the plan author.',
  '',
  '---',
  '',
  '> TL;DR (machine): Quick / Low; deterministic preflight.',
  '',
  '## Scope',
  '### Affected user and ideal state',
  '| Row | Statement | Reason |',
  '| --- | --- | --- |',
  '| IS-1 | A legal plan passes preflight. | structure is the only claim. |',
  '| GAP-1 | No deterministic preflight exists. | 1 closes. |',
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
  '> Implementation + Test = ONE todo. Never separate.',
  '<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->',
  task('1', {
    body: '新建 ' + code('lib/future-preflight.js') + '、' + code('test/future-preflight.test.mjs') + '；阅读 ' + code('lib/plan-source.js:10-12') + '；不修改 ' + code('docs/fidelity.md') + '。评审者可能认为该计划不完整，这只是语义判断。',
    refs: code('lib/plan-source.js:10-12') + '；' + code('docs/fidelity.md') + '；' + code('lib/future-preflight.js') + '；https://example.com/spec；' + code('test/**/*.test.mjs') + '；' + code('$E/task-1.txt') + '；R6（row grammar）；Scope 接口 5。',
  }),
  task('2', { title: 'Prove the read-only property' }),
  task('3', { title: 'Third task' }),
  '~~~md',
  '## Todos',
  '- [ ] 9. fenced demo task, never executed',
  '- [ ] F8. fenced demo final row, never executed',
  '~~~',
  '',
  '## Final verification wave',
  '> Runs in parallel after ALL todos.',
  task('F1', { title: 'Plan compliance audit', category: 'unspecified-high — audit' }),
  task('F2', { title: 'Real manual QA' }),
  '## Commit strategy',
  '- 每个 N 项与测试一起提交。',
  '',
  '## Success criteria',
  '| IS | Delivering todo(s) | Proving QA scenario | Evidence |',
  '| --- | --- | --- | --- |',
  '| IS-1 | 1,2,3,F1,F2 | new-target | ' + code('$E/task-1.txt') + ' |',
  '',
].join('\n')

const BAD_PLAN = [
  '# broken-plan - Work Plan',
  '',
  '## Scope',
  '### Affected user and ideal state',
  '| Row | Statement | Reason |',
  '| --- | --- | --- |',
  '| IS-1 | x | y |',
  '| GAP-1 | x | 1 closes. |',
  '',
  '- [ ] 2. row outside any task section',
  '',
  '## Verification strategy',
  '> zero human intervention',
  '',
  '## Execution strategy',
  '### Parallel execution waves',
  '',
  '## Verification strategy',
  '',
  '## Todos',
  task('1', { title: 'legal task' }),
  task('01', { title: 'leading zero id' }),
  task('0', { title: 'zero id' }),
  task('4', { title: 'duplicate first' }),
  task('4', { title: 'duplicate second' }),
  '- [ ] F-1. malformed final id',
  task('F7', { title: 'final id inside todos' }),
  '\uFEFF- [ ] 5. bom prefixed row',
  task('6', { title: 'missing category and qa', category: null, qa: null }),
  task('7', { title: 'dangling gap', closes: 'GAP-42' }),
  task('8', { title: 'missing existing evidence', refs: code('lib/missing-evidence.js:12-14') + '；bare-missing.txt。' }),
  '## Final verification wave',
  task('9', { title: 'numeric id inside the final wave' }),
  task('F1', { title: 'audit' }),
  '## Commit strategy',
  'Notes about the shipped plan',
  '=====',
  '',
  '## Success criteria ##',
  '| IS | Delivering todo(s) | Proving QA scenario | Evidence |',
  '| --- | --- | --- | --- |',
  '| IS-1 | 42 | nope | ' + code('$E/x.txt') + ' |',
  '',
].join('\n')

async function workspace(t, { slug = 'demo-plan', content = '', files = {} } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'plan-lint-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(dirname(join(root, rel)), { recursive: true })
    await fs.writeFile(join(root, rel), body)
  }
  await fs.mkdir(join(root, '.dsh/ulw/plans'), { recursive: true })
  const path = slug === null ? join(root, 'plan.md') : join(root, '.dsh/ulw/plans', slug + '.md')
  if (content !== null) await fs.writeFile(path, content)
  return { root, path, target: slug === null ? 'plan.md' : '.dsh/ulw/plans/' + slug + '.md' }
}

test('one canonical slug grammar: scaffold, protocol and lint reject a--b and a-', async t => {
  assert.equal(isCanonicalPlanSlug('demo-plan'), true)
  assert.ok(CANONICAL_PLAN_SLUG_RE.test('a1-b2'))
  for (const slug of ['a--b', 'a-', '-a', 'A-b', 'a_b', 'a'.repeat(81), '']) assert.equal(isCanonicalPlanSlug(slug), false, slug)
  assert.equal(planSlugFromPath('.dsh/ulw/plans/a--b.md'), 'a--b')
  assert.equal(planSlugFromPath('/tmp/elsewhere/plan.md'), null)
  const root = await fs.mkdtemp(join(tmpdir(), 'plan-lint-scaffold-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const slug of ['a--b', 'a-']) {
    const failed = spawnSync(process.execPath, [SCAFFOLD, slug], { cwd: root, encoding: 'utf8' })
    assert.equal(failed.status, 1, slug)
    assert.match(failed.stderr, /invalid slug/, slug)
    assert.equal(failed.stdout, '', slug)
    const target = '.dsh/ulw/plans/' + slug + '.md'
    await assert.rejects(fs.stat(join(root, target)), { code: 'ENOENT' }, slug)
    assert.throws(() => parseReviewRequest({ action: 'start', target }), error => error.code === 'INVALID_REQUEST')
  }
  assert.equal(spawnSync(process.execPath, [SCAFFOLD, 'a-b'], { cwd: root, encoding: 'utf8' }).status, 0)
  assert.match(await fs.readFile(join(root, '.dsh/ulw/plans/a-b.md'), 'utf8'), /^# a-b - Work Plan/)
  // The invalid-slug plan is written directly: SLUG_NOT_CANONICAL coverage must not
  // depend on the scaffold accepting a slug that can never be bound for review.
  const fixture = await workspace(t, { slug: 'a--b', content: VALID_PLAN, files: { 'lib/plan-source.js': 'export const x = 1\n', 'docs/fidelity.md': '# fidelity\n' } })
  const result = lintPlan({ content: VALID_PLAN, path: fixture.target, workspace: fixture.root })
  assert.equal(result.valid, false)
  assert.deepEqual(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error').map(diagnostic => diagnostic.code), ['SLUG_NOT_CANONICAL'])
  assert.equal(at(result, 'SLUG_NOT_CANONICAL', 0).line, 0)
  const cli = run([fixture.path], fixture.root)
  assert.equal(cli.status, 2, cli.stderr)
  assert.match(cli.stdout, /error line 0 SLUG_NOT_CANONICAL/)
  assert.match(cli.stdout, /valid=no/)
})

test('a slug-less plan target is a structural error instead of a lintable fixture', async t => {
  const files = { 'lib/plan-source.js': 'export const x = 1\n', 'docs/fidelity.md': '# fidelity\n' }
  const fixture = await workspace(t, { slug: '', content: VALID_PLAN, files })
  assert.equal(fixture.target, '.dsh/ulw/plans/.md')
  assert.equal(planSlugFromPath(fixture.target), '')
  assert.equal(planSlugFromPath(fixture.path), '')
  const result = lintPlan({ content: VALID_PLAN, path: fixture.target, workspace: fixture.root })
  assert.equal(result.valid, false)
  const diagnostic = at(result, 'SLUG_MISSING', 0)
  assert.ok(diagnostic, JSON.stringify(result.diagnostics))
  assert.equal(diagnostic.severity, 'error')
  assert.ok(ERROR_CODES.includes('SLUG_MISSING'))
  assert.ok(PLAN_LINT_CODES.includes('SLUG_MISSING'))
  assert.deepEqual(result.diagnostics.map(entry => entry.code), ['SLUG_MISSING'])
  assert.equal(result.sha256, hash(VALID_PLAN))
  for (const target of [fixture.target, fixture.path]) {
    const cli = run([target], fixture.root)
    assert.equal(cli.status, 2, target + '\n' + cli.stderr)
    assert.match(cli.stdout, /error line 0 SLUG_MISSING/, target)
    assert.match(cli.stdout, /valid=no/, target)
    assert.doesNotMatch(cli.stdout, /valid=yes/, target)
  }
  const json = run([fixture.target, '--json'], fixture.root)
  assert.equal(json.status, 2)
  assert.deepEqual(JSON.parse(json.stdout).diagnostics.map(entry => entry.code), ['SLUG_MISSING'])
  // The other surfaces keep rejecting the same target.
  await assert.rejects(createReviewArtifact({ workspace: fixture.root, target: fixture.target }), error => error.code === 'INVALID_SOURCE')
  assert.throws(() => parseReviewRequest({ action: 'start', target: fixture.target }), error => error.code === 'INVALID_REQUEST')
  const scaffold = spawnSync(process.execPath, [SCAFFOLD, ''], { cwd: fixture.root, encoding: 'utf8' })
  assert.equal(scaffold.status, 1)
  assert.equal(scaffold.stdout, '')
  // Fixtures outside .dsh/ulw/plans/ are still lintable without a slug.
  const outside = await workspace(t, { slug: null, content: VALID_PLAN, files })
  assert.equal(planSlugFromPath(outside.target), null)
  assert.equal(lintPlan({ content: VALID_PLAN, path: outside.target, workspace: outside.root }).valid, true)
})

test('a legal plan with new targets, evidence paths, urls, globs and fenced demos passes with exact counts', async t => {
  const fixture = await workspace(t, { content: VALID_PLAN, files: { 'lib/plan-source.js': 'export const x = 1\n', 'docs/fidelity.md': '# fidelity\n' } })
  const parsed = parsePlanDocument(VALID_PLAN)
  assert.deepEqual(parsed.tasks.map(entry => entry.id), ['1', '2', '3', 'F1', 'F2'])
  assert.deepEqual(parsed.counts, { tasks: 5, todos: 3, final: 2, shadowed: 2 })
  const result = lintPlan({ content: VALID_PLAN, path: fixture.target, workspace: fixture.root })
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), [])
  assert.equal(result.valid, true)
  assert.equal(result.sha256, hash(VALID_PLAN))
  assert.deepEqual(parsed.shadowed.map(entry => entry.line), [lineOf(VALID_PLAN, '- [ ] 9. fenced'), lineOf(VALID_PLAN, '- [ ] F8. fenced')])
  for (const expected of ['TASK_ROW_FENCED', 'REFERENCE_UNRESOLVED']) assert.ok(at(result, expected), expected)
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.severity, 'warning')
    assert.ok(PLAN_LINT_CODES.includes(diagnostic.code))
  }
})

test('objective structural faults carry precise line numbers and never semantic speculation', () => {
  const result = lintPlan({ content: BAD_PLAN, workspace: '/workspace' })
  assert.equal(result.valid, false)
  const strategyLines = BAD_PLAN.split('\n').flatMap((line, index) => line === '## Verification strategy' ? [index + 1] : [])
  const secondStrategy = strategyLines[1]
  const expected = [
    ['TASK_ROW_OUTSIDE_SECTION', lineOf(BAD_PLAN, '- [ ] 2. row outside')],
    ['SECTION_DUPLICATE', secondStrategy],
    ['TASK_ID_INVALID', lineOf(BAD_PLAN, '- [ ] 01.')],
    ['TASK_ID_INVALID', lineOf(BAD_PLAN, '- [ ] 0.')],
    ['TASK_ID_DUPLICATE', lineOf(BAD_PLAN, '- [ ] 4. duplicate second')],
    ['TASK_ROW_MALFORMED', lineOf(BAD_PLAN, '- [ ] F-1.')],
    ['TASK_SECTION_MISMATCH', lineOf(BAD_PLAN, '- [ ] F7.')],
    ['TASK_ROW_BOM', lineOf(BAD_PLAN, '\uFEFF- [ ] 5. bom')],
    ['TASK_CATEGORY_MISSING', lineOf(BAD_PLAN, '- [ ] 6. missing category')],
    ['TASK_QA_MISSING', lineOf(BAD_PLAN, '- [ ] 6. missing category')],
    ['GAP_UNKNOWN', lineOf(BAD_PLAN, 'Closes: GAP-42')],
    ['REFERENCE_MISSING_EXISTING', lineOf(BAD_PLAN, 'lib/missing-evidence.js')],
    ['TASK_SECTION_MISMATCH', lineOf(BAD_PLAN, '- [ ] 9. numeric id')],
    ['HEADING_SETEXT', lineOf(BAD_PLAN, '=====')],
    ['HEADING_CLOSING_HASH', lineOf(BAD_PLAN, '## Success criteria ##')],
    ['IS_MAPPING_UNKNOWN', lineOf(BAD_PLAN, '| IS-1 | 42 |')],
  ]
  for (const [expectedCode, expectedLine] of expected) assert.ok(at(result, expectedCode, expectedLine), expectedCode + ' at ' + expectedLine + '\n' + JSON.stringify(result.diagnostics, null, 1))
  for (const diagnostic of result.diagnostics) {
    assert.ok(PLAN_LINT_CODES.includes(diagnostic.code), diagnostic.code)
    if (diagnostic.severity === 'error') assert.ok(ERROR_CODES.includes(diagnostic.code), diagnostic.code)
    assert.ok(Number.isInteger(diagnostic.line) && diagnostic.line >= 0)
    assert.equal(typeof diagnostic.taskId, 'string')
    assert.ok(diagnostic.message.length > 0)
    assert.ok(!/semantic|meaning|probably|likely|maybe/i.test(diagnostic.message), diagnostic.message)
  }
  assert.equal(at(result, 'GAP_UNKNOWN', lineOf(BAD_PLAN, 'Closes: GAP-42')).taskId, '7')
})

test('final-wave rows use the verification slot contract, like the canonical template', () => {
  const content = ['## Todos', task('1', { closes: null }), '## Final verification wave', '- [ ] F1. Plan compliance audit', '  Recommended task executor category: unspecified-high — audit', '  QA scenarios: Happy “audit”。', '  Acceptance criteria: 每项有证据。', ''].join('\n')
  const result = lintPlan({ content })
  assert.equal(result.valid, true)
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), [])
  assert.ok(result.diagnostics.some(d => d.code === 'TASK_PARALLELIZATION_MISSING' && d.severity === 'warning'))
  const implementation = lintPlan({ content: ['## Todos', '- [ ] 1. x', '  Recommended task executor category: quick — y', '  QA scenarios: Happy “x”。', '  Acceptance criteria: y', '## Final verification wave', ''].join('\n') })
  assert.equal(implementation.valid, false)
  for (const expected of ['TASK_REFERENCES_MISSING', 'TASK_COMMIT_MISSING']) assert.ok(at(implementation, expected, 2), expected)
})

test('non-canonical structures are rejected exactly where they appear', () => {
  const samples = [
    ['bom row', '## Todos\n\uFEFF- [ ] 1. bom row\n', 'TASK_ROW_BOM', 2],
    ['leading zero', '## Todos\n- [ ] 01. leading zero\n', 'TASK_ID_INVALID', 2],
    ['zero id', '## Todos\n- [ ] 0. zero\n', 'TASK_ID_INVALID', 2],
    ['final zero', '## Todos\n- [ ] F0. final zero\n', 'TASK_ID_INVALID', 2],
    ['final negative', '## Todos\n- [ ] F-1. final negative\n', 'TASK_ROW_MALFORMED', 2],
    ['duplicate', '## Todos\n- [ ] 2. first\n- [ ] 2. second\n', 'TASK_ID_DUPLICATE', 3],
    ['final in todos', '## Todos\n- [ ] F7. wrong section\n', 'TASK_SECTION_MISMATCH', 2],
    ['numeric in final', '## Final verification wave\n- [ ] 7. wrong section\n', 'TASK_SECTION_MISMATCH', 2],
    ['indented', '## Todos\n  - [ ] 3. indented\n', 'TASK_ROW_INDENTED', 2],
    ['quoted', '## Todos\n> - [ ] 3. quoted\n', 'TASK_ROW_QUOTED', 2],
    ['fenced', '## Todos\n' + FENCE + 'md\n- [ ] 3. fenced\n' + FENCE + '\n', 'TASK_ROW_FENCED', 3],
    ['commented', '## Todos\n<!--\n- [ ] 3. commented\n-->\n', 'TASK_ROW_COMMENTED', 3],
    ['setext heading', '## Todos\n- [ ] 1. task\n  Commit: Y | x\nNotes\n=====\n', 'HEADING_SETEXT', 5],
    ['closing hash', '## Todos ##\n- [ ] 1. task\n', 'HEADING_CLOSING_HASH', 1],
    ['missing section', '## Scope\n', 'SECTION_MISSING', 0],
    ['section order', '## Todos\n\n## Scope\n', 'SECTION_ORDER', 3],
    ['missing category', '## Todos\n- [ ] 1. x\n  What to do / Must NOT do: y\n', 'TASK_CATEGORY_MISSING', 2],
    ['missing references', '## Todos\n- [ ] 1. x\n  Recommended task executor category: quick — y\n', 'TASK_REFERENCES_MISSING', 2],
    ['missing acceptance', '## Todos\n- [ ] 1. x\n  Recommended task executor category: quick — y\n  References: a/b.md\n', 'TASK_ACCEPTANCE_MISSING', 2],
    ['missing qa', '## Todos\n- [ ] 1. x\n  References: a/b.md\n  Acceptance criteria: y\n', 'TASK_QA_MISSING', 2],
    ['missing commit', '## Todos\n- [ ] 1. x\n  QA scenarios: y\n', 'TASK_COMMIT_MISSING', 2],
    ['unknown prose', '## Todos\n- [ ] 1. x\n  References: R7（标准）；N3\n  Acceptance criteria: y\n', 'REFERENCE_UNRESOLVED', 3],
    ['unknown category', '## Todos\n- [ ] 1. x\n  Recommended task executor category: super-duper — y\n', 'TASK_CATEGORY_UNKNOWN', 3],
    ['dangling gap', '| GAP-3 | gap | 1 closes. |\n## Todos\n- [ ] 1. x\n  Closes: GAP-1\n', 'GAP_UNKNOWN', 4],
  ]
  for (const [name, content, expectedCode, expectedLine] of samples) {
    const result = lintPlan({ content, workspace: '/workspace' })
    assert.equal(result.valid, false, name)
    assert.ok(at(result, expectedCode, expectedLine), name + ': expected ' + expectedCode + ' at line ' + expectedLine + '; got ' + JSON.stringify(result.diagnostics))
  }
})

test('row selection agrees with plan-state across fenced, quoted, nested, commented and flat plans', () => {
  const samples = [
    '## Todos\n- [ ] 1. a\n## Final verification wave\n- [ ] F1. b\n',
    '## Scope\n- [ ] 8. row\n',
    '## Todos\n  - [ ] 8. row\n',
    '## Todos\n> - [ ] 8. row\n',
    '## Todos\n\t- [ ] 8. row\n',
    '## Todos\n~~~md\n- [ ] 8. row\n~~~\n',
    '## Todos\n<!--\n- [ ] 8. row\n-->\n',
    '<!--\n## Todos\n-->\n- [ ] 8. row\n',
    '## Todos\n### Example\n- [ ] 8. row\n',
    '## Final verification wave\n- [ ] 8. row\n',
    '## Todos\n- [ ] F8. row\n',
    '## Todos\n- [ ] 0. row\n',
    '## Todos\n- [ ] 08. row\n',
    '## Todos\n- [ ] 8. first\n- [ ] 8. duplicate\n',
    '## Todos\n- [x] 1. done\n- [~] 2. blocked\n- [ ] 3. open\n',
    '# no sections\n- [ ] 4. flat row\n',
    '## Notes\n- [ ] 4. row under a non-canonical H2\n',
    '## Todos\n~~~~\n- [ ] 5. unclosed fence\n',
  ]
  for (const sample of samples) {
    assert.deepEqual(parsePlanDocument(sample).tasks.map(entry => entry.id), parseRows(sample).map(row => row.id), sample)
    const result = lintPlan({ content: sample, workspace: '/workspace' })
    assert.equal(typeof result.valid, 'boolean')
    assert.equal(result.sha256, hash(sample))
  }
  assert.deepEqual(parsePlanDocument(samples[0]).tasks.map(entry => entry.id), ['1', 'F1'])
})

test('existing source citations must resolve, while create, evidence, glob and url targets never block', async t => {
  const fixture = await workspace(t, { content: VALID_PLAN, files: { 'lib/plan-source.js': 'export const x = 1\n', 'docs/fidelity.md': '# fidelity\n' } })
  const ok = lintPlan({ content: VALID_PLAN, path: fixture.target, workspace: fixture.root })
  assert.equal(ok.valid, true)
  const withReferences = refs => VALID_PLAN.split('\n').map(line => line.trimStart().startsWith('References:') && line.includes('lib/plan-source.js') ? '  References: ' + refs : line).join('\n')
  assert.equal(ok.diagnostics.filter(d => d.code === 'REFERENCE_MISSING_EXISTING').length, 0)
  const missing = withReferences(code('lib/missing-source.js:12-14') + '。')
  const broken = lintPlan({ content: missing, path: fixture.target, workspace: fixture.root })
  assert.equal(broken.valid, false)
  assert.equal(broken.diagnostics.filter(d => d.code === 'REFERENCE_MISSING_EXISTING').length, 1)
  assert.ok(at(broken, 'REFERENCE_MISSING_EXISTING', lineOf(missing, 'lib/missing-source.js')))
  const anchored = withReferences(code('docs/fidelity.md#L162-L174') + '。')
  assert.equal(lintPlan({ content: anchored, path: fixture.target, workspace: fixture.root }).valid, true)
  const absent = withReferences(code('lib/not-created-yet.js') + '。')
  const created = lintPlan({ content: absent, path: fixture.target, workspace: fixture.root })
  assert.equal(created.valid, true)
  assert.ok(at(created, 'REFERENCE_UNRESOLVED', lineOf(absent, 'lib/not-created-yet.js')))
})

test('lint binds the analyzed bytes: a rewritten source can never be reported as linted', async t => {
  const fixture = await workspace(t, { content: VALID_PLAN })
  const analyzed = Buffer.from(VALID_PLAN)
  const rewritten = VALID_PLAN.replace('Third task', 'Third task rewritten on disk')
  await fs.writeFile(fixture.path, rewritten)
  const result = lintPlan({ content: analyzed, path: fixture.target, workspace: fixture.root })
  assert.equal(result.sha256, hash(analyzed))
  assert.notEqual(result.sha256, hash(rewritten))
  assert.equal(hash(await fs.readFile(fixture.path)), hash(rewritten))
})

test('CLI is read-only, deterministic and reports exit 0/2/5 with machine fields only', async t => {
  const fixture = await workspace(t, { content: VALID_PLAN, files: { 'lib/plan-source.js': 'export const x = 1\n', 'docs/fidelity.md': '# fidelity\n' } })
  const before = { bytes: await fs.readFile(fixture.path), stat: await fs.stat(fixture.path), entries: await fs.readdir(join(fixture.root, '.dsh/ulw/plans')) }
  const runs = [1, 2, 3].map(() => run([fixture.target, '--json'], fixture.root))
  for (const result of runs) {
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim().split('\n').length, 1)
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(payload).sort(), ['diagnostics', 'sha256', 'valid'])
    assert.equal(payload.valid, true)
    assert.equal(payload.sha256, hash(before.bytes))
    for (const diagnostic of payload.diagnostics) assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'line', 'message', 'severity', 'taskId'])
  }
  assert.equal(new Set(runs.map(result => result.stdout)).size, 1)
  const after = { bytes: await fs.readFile(fixture.path), stat: await fs.stat(fixture.path), entries: await fs.readdir(join(fixture.root, '.dsh/ulw/plans')) }
  assert.deepEqual(after.bytes, before.bytes)
  assert.equal(after.stat.size, before.stat.size)
  assert.equal(after.stat.mtimeMs, before.stat.mtimeMs)
  assert.deepEqual(after.entries, before.entries)

  await fs.writeFile(join(fixture.root, '.dsh/ulw/plans/broken-plan.md'), BAD_PLAN)
  const bad = run(['.dsh/ulw/plans/broken-plan.md', '--json'], fixture.root)
  assert.equal(bad.status, 2)
  const payload = JSON.parse(bad.stdout)
  assert.equal(payload.valid, false)
  for (const expectedCode of ['TASK_ID_DUPLICATE', 'TASK_QA_MISSING', 'REFERENCE_MISSING_EXISTING']) assert.ok(payload.diagnostics.some(d => d.code === expectedCode), expectedCode)

  const text = run([fixture.target], fixture.root)
  assert.equal(text.status, 0)
  assert.match(text.stdout, /valid=yes/)
  assert.match(text.stdout, /structural preflight only/)
  assert.doesNotMatch(text.stdout, /approved|OKAY/i)
  assert.equal(run([], fixture.root).status, 5)
  assert.equal(run([fixture.target, '--bogus'], fixture.root).status, 5)
  assert.equal(run([fixture.target, 'extra-path'], fixture.root).status, 5)
  assert.equal(run(['.dsh/ulw/plans/missing.md'], fixture.root).status, 5)
  assert.equal(run(['.dsh/ulw'], fixture.root).status, 5)
  const help = run(['--help'], fixture.root)
  assert.equal(help.status, 0)
  assert.match(help.stdout, /plan-lint\.mjs <plan\.md>/)
})

test('a FIFO source refuses instead of blocking the CLI', { skip: process.platform === 'win32', timeout: 6000 }, async t => {
  const fixture = await workspace(t, { content: null })
  execFileSync('mkfifo', [fixture.path])
  const started = Date.now()
  const result = run([fixture.target], fixture.root)
  assert.equal(result.status, 5)
  assert.ok(Date.now() - started < 3000)
  assert.match(result.stderr, /regular file/)
})

test('recurrent atomic replacements never yield a torn hash or a hanging run', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const fixture = await workspace(t, { content: VALID_PLAN })
  const other = VALID_PLAN.replace('Third task', 'Third task rewritten while linting')
  const allowed = new Set([hash(VALID_PLAN), hash(other)])
  // Atomic replace writer: every version is written to a complete temp file in the
  // same directory and then renamed over the target. A reader holding one descriptor
  // can therefore only observe a complete version, so the assertion below is a
  // property this product can actually uphold. An in-place rewrite cannot be tested
  // this way: a single descriptor may read a mixed stream when the rewrite lands
  // between reads (the deterministic barrier test below covers that case).
  const writer = 'const fs=require("node:fs");const p=process.argv[1],a=process.argv[2],b=process.argv[3],tmp=process.argv[4];for(let n=0;n<300;n+=1){fs.writeFileSync(tmp,n%2?a:b);fs.renameSync(tmp,p)}'
  for (let round = 0; round < 8; round += 1) {
    await fs.writeFile(fixture.path, round % 2 === 0 ? VALID_PLAN : other)
    const child = spawn(process.execPath, ['-e', writer, fixture.path, VALID_PLAN, other, join(fixture.root, 'plan.tmp')], { stdio: 'ignore' })
    const done = new Promise(resolve => child.on('exit', resolve))
    const result = run([fixture.target, '--json'], fixture.root)
    await done
    assert.ok([0, 2, 5].includes(result.status), String(result.status))
    if (result.status === 5) assert.match(result.stderr, /changed while reading/)
    else assert.ok(allowed.has(JSON.parse(result.stdout).sha256), 'reported hash must belong to a complete on-disk version')
  }
})

// Test-only barrier: the second fstat re-check in readSource is the freshness gate.
// Mutating the source right before it (append one byte, so the size differs even on
// a filesystem with coarse timestamps) makes the race deterministic with no sleeps.
const FRESHNESS_BARRIER_HOOK = `const fs = require('node:fs')
const original = fs.fstatSync
let calls = 0
let mutated = false
fs.fstatSync = function (fd, ...rest) {
  calls += 1
  if (calls === 2 && !mutated) {
    mutated = true
    fs.appendFileSync(process.env.PLAN_LINT_BARRIER, 'X')
  }
  return original.call(this, fd, ...rest)
}
require('node:module').syncBuiltinESMExports()
`

test('a controlled in-place rewrite between read and fstat re-check is refused, never hashed', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const fixture = await workspace(t, { content: VALID_PLAN, files: { 'lib/plan-source.js': 'export const x = 1\n', 'docs/fidelity.md': '# fidelity\n' } })
  const hookPath = join(fixture.root, 'freshness-barrier.cjs')
  await fs.writeFile(hookPath, FRESHNESS_BARRIER_HOOK)
  const result = spawnSync(process.execPath, ['--require', hookPath, CLI, fixture.target, '--json'], {
    cwd: fixture.root,
    env: { ...process.env, PLAN_LINT_BARRIER: fixture.path },
    encoding: 'utf8',
  })
  assert.equal(result.status, 5)
  assert.match(result.stderr, /changed while reading/)
  assert.equal(result.stdout, '')
  assert.equal(await fs.readFile(fixture.path, 'utf8'), VALID_PLAN + 'X')
})

// A minimal legal plan: two canonical sections, one task with every required slot.
const MINIMAL_LEGAL_PLAN = [
  '## Todos',
  '- [ ] 1. real task',
  '  Recommended task executor category: quick — y',
  '  What to do / Must NOT do: z',
  '  References: ' + code('$E/x.txt'),
  '  Acceptance criteria: y',
  '  QA scenarios: z',
  '  Commit: Y | test(plan): x',
  '## Final verification wave',
  '',
].join('\n')

test('plan-state selection and lint task ids agree on CRLF, BOM, frontmatter and fences', () => {
  const lf = ['# demo', '## Todos', FENCE + 'md', '- [ ] 90. fenced demo', FENCE, '- [ ] 1. real', '## Final verification wave', '- [ ] F1. audit', ''].join('\n')
  const crlf = lf.replace(/\n/g, '\r\n')
  const frontmatter = ['---', 'title: demo', '## Todos', '- [ ] 90. frontmatter demo', '---', '## Todos', '- [ ] 1. real', '## Final verification wave', '- [ ] F1. audit', ''].join('\n')
  const samples = [
    ['lf fenced demo', lf, ['1', 'F1']],
    ['crlf fenced demo', crlf, ['1', 'F1']],
    ['crlf frontmatter', frontmatter.replace(/\n/g, '\r\n'), ['1', 'F1']],
    ['bom before heading', '\uFEFF' + lf, ['1', 'F1']],
    ['bom first-line row', '\uFEFF- [ ] 1. bom row\n- [ ] 2. plain\n', ['2']],
    ['bom mid-file row', '## Todos\n\uFEFF- [ ] 3. bom row\n- [ ] 4. real\n', ['4']],
    ['frontmatter task section', frontmatter, ['1', 'F1']],
    ['unclosed frontmatter opener', '---\n## Todos\n- [ ] 1. real\n', ['1']],
  ]
  for (const [name, content, expected] of samples) {
    const lintIds = parsePlanDocument(content).tasks.map(entry => entry.id)
    const stateIds = parseRows(content).map(row => row.id)
    assert.deepEqual(stateIds, expected, name + ' plan-state')
    assert.deepEqual(lintIds, expected, name + ' lint')
    assert.deepEqual(stateIds, lintIds, name + ' parity')
  }
  const bytes = Buffer.from(crlf, 'utf8')
  assert.deepEqual(parseRows(bytes).map(row => row.id), parsePlanDocument(bytes).tasks.map(entry => entry.id))
})

test('invalid UTF-8 is refused with the stable INVALID_UTF8 code, never silently repaired', async t => {
  assert.equal(lintPlan({ content: MINIMAL_LEGAL_PLAN }).valid, true)
  const invalid = Buffer.concat([Buffer.from(MINIMAL_LEGAL_PLAN, 'utf8'), Buffer.from([0xff, 0xfe, 0xfd])])
  const result = lintPlan({ content: invalid })
  assert.equal(result.valid, false)
  const diagnostic = at(result, 'INVALID_UTF8', 0)
  assert.ok(diagnostic, JSON.stringify(result.diagnostics))
  assert.equal(diagnostic.severity, 'error')
  assert.equal(diagnostic.taskId, '')
  assert.ok(ERROR_CODES.includes('INVALID_UTF8'))
  assert.ok(PLAN_LINT_CODES.includes('INVALID_UTF8'))
  assert.equal(result.diagnostics.filter(d => d.code === 'INVALID_UTF8').length, 1)
  assert.equal(result.sha256, hash(invalid))
  assert.throws(() => parsePlanDocument(invalid), error => error.code === 'INVALID_UTF8')
  assert.throws(() => computeInstructionSha256(invalid), error => error.code === 'INVALID_UTF8')
  const fixture = await workspace(t, { content: invalid })
  const json = run([fixture.target, '--json'], fixture.root)
  assert.equal(json.status, 2)
  const payload = JSON.parse(json.stdout)
  assert.equal(payload.valid, false)
  assert.equal(payload.sha256, hash(invalid))
  assert.ok(payload.diagnostics.some(d => d.code === 'INVALID_UTF8'))
  const text = run([fixture.target], fixture.root)
  assert.equal(text.status, 2)
  assert.match(text.stdout, /valid=no/)
  assert.match(text.stdout, /INVALID_UTF8/)
  assert.doesNotMatch(text.stdout, /valid=yes/)
})

test('--workspace makes the CLI verdict independent of cwd', async t => {
  const fixture = await workspace(t, { content: VALID_PLAN, files: { 'lib/plan-source.js': 'export const x = 1\n', 'docs/fidelity.md': '# fidelity\n' } })
  const elsewhere = await fs.mkdtemp(join(tmpdir(), 'plan-lint-cwd-'))
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }))
  // Default stays process.cwd(): the shipped-style plan resolves references only from
  // the workspace root, so another cwd produces reference errors.
  assert.equal(run([fixture.target], fixture.root).status, 0)
  const cwdDependent = run([fixture.path], elsewhere)
  assert.equal(cwdDependent.status, 2)
  const explicit = run([fixture.path, '--workspace', fixture.root, '--json'], elsewhere)
  assert.equal(explicit.status, 0)
  const fromRoot = run([fixture.path, '--json'], fixture.root)
  assert.equal(explicit.stdout, fromRoot.stdout)
  assert.equal(JSON.parse(explicit.stdout).sha256, hash(VALID_PLAN))
  assert.equal(run([fixture.path, '--workspace=' + fixture.root], elsewhere).status, 0)
  assert.equal(run([fixture.path, '--workspace'], elsewhere).status, 5)
  assert.equal(run([fixture.path, '--workspace', join(elsewhere, 'missing')], elsewhere).status, 5)
  assert.equal(run([fixture.path, '--workspace', fixture.path], elsewhere).status, 5)
})

test('a FIFO source still refuses with an explicit workspace and never blocks', { skip: process.platform === 'win32', timeout: 6000 }, async t => {
  const fixture = await workspace(t, { content: null })
  execFileSync('mkfifo', [fixture.path])
  const started = Date.now()
  const result = run([fixture.target, '--workspace', fixture.root], fixture.root)
  assert.equal(result.status, 5)
  assert.ok(Date.now() - started < 3000)
  assert.match(result.stderr, /regular file/)
})

// --- Row 25: the instruction scan treats an HTML block as prose, while plan-state
// and lint still honor the canonical heading or row inside it. Lint must therefore
// fail closed on those markers: a legal plan-state tick would otherwise change
// computeInstructionSha256 and instruction-mode revalidation would report stale.

const HTML_ROW = [
  '- [ ] 1. task inside an HTML block',
  '  Recommended task executor category: quick — mechanical',
  '  What to do / Must NOT do: keep every byte.',
  '  References: ' + code('$E/x.txt'),
  '  Acceptance criteria: lint stays valid.',
  '  QA scenarios: one legal tick.',
  '  Commit: Y | test(plan): x',
]
const HTML_FINAL_ROW = [
  '- [ ] F1. final audit inside an HTML block',
  '  Recommended task executor category: unspecified-high — audit',
  '  What to do / Must NOT do: audit.',
  '  Acceptance criteria: lint stays valid.',
  '  QA scenarios: audit tick.',
  '  Commit: Y | test(plan): x',
]
const TASK_TAIL = ['## Final verification wave', '']
const ROW_IN_DIV = ['## Todos', '<div>', ...HTML_ROW, '</div>', ...TASK_TAIL]

// Line arrays keep every expected diagnostic line exact.
const HTML_DIVERGENT = [
  ['task row wrapped in a div', ROW_IN_DIV, [['TASK_ROW_HTML_BLOCK', 3]]],
  ['section heading wrapped in a div', ['<div>', '## Todos', '</div>', ...HTML_ROW, ...TASK_TAIL], [['SECTION_HTML_BLOCK', 2]]],
  ['final heading wrapped in a div', ['## Todos', ...HTML_ROW, '<div>', '## Final verification wave', '</div>', ...HTML_FINAL_ROW, ''], [['SECTION_HTML_BLOCK', 10]]],
  ['task row in a details block', ['## Todos', '<details>', ...HTML_ROW, '</details>', ...TASK_TAIL], [['TASK_ROW_HTML_BLOCK', 3]]],
  ['uppercase tag with an attribute', ['## Todos', '<DIV class="x">', ...HTML_ROW, '</DIV>', ...TASK_TAIL], [['TASK_ROW_HTML_BLOCK', 3]]],
  ['space-indented tag', ['## Todos', '  <div>', ...HTML_ROW, '  </div>', ...TASK_TAIL], [['TASK_ROW_HTML_BLOCK', 3]]],
  ['nested tags on one line', ['## Todos', '<div><div>', ...HTML_ROW, '</div></div>', ...TASK_TAIL], [['TASK_ROW_HTML_BLOCK', 3]]],
  ['unclosed block', ['## Todos', '<div>', ...HTML_ROW, '## Final verification wave', ''], [['TASK_ROW_HTML_BLOCK', 3], ['SECTION_HTML_BLOCK', 10]]],
  ['block opened inside frontmatter', ['---', '<div>', '---', '## Todos', ...HTML_ROW, '</div>', ...TASK_TAIL], [['SECTION_HTML_BLOCK', 4], ['TASK_ROW_HTML_BLOCK', 5]]],
  ['block opened after a comment closes', ['## Todos', '<!--', '--><div>', ...HTML_ROW, '</div>', ...TASK_TAIL], [['TASK_ROW_HTML_BLOCK', 4]]],
  ['canonical heading hidden without any row', ['## Todos', ...HTML_ROW, '<div>', '## Final verification wave', '</div>', ''], [['SECTION_HTML_BLOCK', 10]]],
  ['close tag masked by an HTML comment', ['## Todos', '<div>', '<!--', '</div>', '-->', ...HTML_ROW, ...TASK_TAIL], [['TASK_ROW_HTML_BLOCK', 6]]],
]

// Ordinary prose HTML, and HTML-shaped text the instruction scan does not treat as
// a block, must all stay legal.
const HTML_LEGAL = [
  ['prose block after the rows', ['## Todos', ...HTML_ROW, '<div>', 'ordinary prose only', '</div>', ...TASK_TAIL]],
  ['self-closing tag', ['## Todos', '<div/>', ...HTML_ROW, ...TASK_TAIL]],
  ['open and close on one line', ['## Todos', '<div></div>', ...HTML_ROW, ...TASK_TAIL]],
  ['void tag', ['## Todos', '<img src="x">', ...HTML_ROW, ...TASK_TAIL]],
  ['four-space indented tag', ['## Todos', '    <div>', ...HTML_ROW, ...TASK_TAIL]],
  ['tag inside a comment', ['## Todos', '<!-- <div> -->', ...HTML_ROW, ...TASK_TAIL]],
  ['fenced html sample', ['## Todos', FENCE + 'html', '<div>', FENCE, ...HTML_ROW, ...TASK_TAIL]],
  ['block closed before the row', ['## Todos', '<div>', 'prose', '</div>', ...HTML_ROW, ...TASK_TAIL]],
  ['non-canonical heading inside a block', ['## Todos', ...HTML_ROW, '<div>', '## Notes', '</div>', ...TASK_TAIL]],
  ['block opened and closed inside frontmatter', ['---', '<div>', '</div>', '---', '## Todos', ...HTML_ROW, ...TASK_TAIL]],
]

test('canonical sections and task rows inside HTML blocks are structural errors', () => {
  for (const [name, lines, expected] of HTML_DIVERGENT) {
    for (const eol of ['\n', '\r\n']) {
      const content = lines.join(eol)
      const result = lintPlan({ content })
      assert.equal(result.valid, false, name + ' ' + JSON.stringify(eol))
      for (const [expectedCode, expectedLine] of expected) {
        const diagnostic = at(result, expectedCode, expectedLine)
        assert.ok(diagnostic, name + ' expected ' + expectedCode + ' at line ' + expectedLine + ': ' + JSON.stringify(result.diagnostics))
        assert.equal(diagnostic.severity, 'error', name)
        assert.ok(ERROR_CODES.includes(expectedCode), expectedCode)
        assert.ok(PLAN_LINT_CODES.includes(expectedCode), expectedCode)
      }
      assert.deepEqual(lintPlan({ content }), result, name + ' is deterministic')
    }
  }
})

test('ordinary prose HTML and HTML-shaped text outside a block stay legal', () => {
  for (const [name, lines] of HTML_LEGAL) {
    for (const eol of ['\n', '\r\n']) {
      const content = lines.join(eol)
      const result = lintPlan({ content })
      assert.equal(result.valid, true, name + ' ' + JSON.stringify(eol) + ': ' + JSON.stringify(result.diagnostics))
      assert.deepEqual(result.diagnostics.filter(diagnostic => diagnostic.code === 'SECTION_HTML_BLOCK' || diagnostic.code === 'TASK_ROW_HTML_BLOCK'), [], name)
    }
  }
})

test('the refused HTML-wrapped markers are exactly those whose legal tick changes instruction identity', () => {
  const content = ROW_IN_DIV.join('\n')
  assert.equal(lintPlan({ content }).valid, false)
  const ticked = applyTick(content, '1', 'x')
  assert.equal(ticked.changed, true)
  assert.notEqual(computeInstructionSha256(ticked.content), computeInstructionSha256(content))
  assert.notEqual(hash(ticked.content), hash(content))
  // A hidden canonical heading also has a legal tick behind it: the F1 row after the
  // block is selected by plan-state under the hidden Final wave, but the instruction
  // scan still believes it is inside "## Todos" and does not normalize the status byte.
  const hiddenFinal = ['## Todos', ...HTML_ROW, '<div>', '## Final verification wave', '</div>', ...HTML_FINAL_ROW, ''].join('\n')
  assert.ok(at(lintPlan({ content: hiddenFinal }), 'SECTION_HTML_BLOCK', 10))
  const finalTick = applyTick(hiddenFinal, 'F1', 'x')
  assert.equal(finalTick.changed, true)
  assert.notEqual(computeInstructionSha256(finalTick.content), computeInstructionSha256(hiddenFinal))
})

test('no lint-valid plan lets a legal tick change instruction identity or leave raw identity unchanged', () => {
  const generated = []
  for (const tag of ['div', 'details', 'section', 'pre', 'blockquote', 'table', 'custom-tag']) {
    for (const indent of ['', ' ', '  ', '   ']) {
      generated.push(['## Todos', indent + '<' + tag + ' class="x">', ...HTML_ROW, indent + '</' + tag + '>', ...TASK_TAIL])
    }
    for (const indent of ['    ', '     ']) {
      generated.push(['## Todos', indent + '<' + tag + '>', ...HTML_ROW, indent + '</' + tag + '>', ...TASK_TAIL])
    }
  }
  let checks = 0
  for (const [, lines] of [...HTML_DIVERGENT, ...HTML_LEGAL, generated]) {
    for (const eol of ['\n', '\r\n']) {
      const content = lines.join(eol)
      if (!lintPlan({ content }).valid) continue
      const rows = parseRows(content)
      assert.ok(rows.length > 0, 'a lint-valid fixture still has executable rows')
      for (const row of rows) {
        for (const status of ['x', '~']) {
          const ticked = applyTick(content, row.id, status)
          const label = row.id + ' -> ' + status
          assert.equal(ticked.changed, true, label)
          assert.equal(computeInstructionSha256(ticked.content), computeInstructionSha256(content), label + ' must not change instruction identity')
          assert.notEqual(hash(ticked.content), hash(content), label + ' must still change the raw identity')
          checks += 1
        }
      }
    }
  }
  assert.ok(checks >= 40, 'the invariant covered ' + checks + ' legal ticks')
})

test('the HTML-block refusal is a stable CLI exit 2 while prose HTML stays exit 0', async t => {
  const fixture = await workspace(t, { content: ROW_IN_DIV.join('\n') })
  for (const eol of ['\n', '\r\n']) {
    const content = ROW_IN_DIV.join(eol)
    await fs.writeFile(fixture.path, content)
    const text = run([fixture.target], fixture.root)
    assert.equal(text.status, 2, text.stderr)
    assert.match(text.stdout, /error line 3 TASK_ROW_HTML_BLOCK/)
    assert.match(text.stdout, /valid=no/)
    const json = run([fixture.target, '--json'], fixture.root)
    assert.equal(json.status, 2)
    const payload = JSON.parse(json.stdout)
    assert.equal(payload.valid, false)
    assert.equal(payload.sha256, hash(content))
    assert.deepEqual(payload.diagnostics.filter(diagnostic => diagnostic.code === 'TASK_ROW_HTML_BLOCK').map(diagnostic => diagnostic.line), [3])
  }
  await fs.writeFile(fixture.path, HTML_LEGAL[0][1].join('\n'))
  const ok = run([fixture.target], fixture.root)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /valid=yes/)
})

test('instruction-mode revalidation would go stale on the tick lint now refuses', async t => {
  const content = ROW_IN_DIV.join('\n')
  const fixture = await workspace(t, { content })
  assert.equal(lintPlan({ content }).valid, false)
  const artifact = await createReviewArtifact({ workspace: fixture.root, target: fixture.target })
  const ticked = applyTick(content, '1', 'x').content
  await fs.writeFile(fixture.path, ticked)
  const revalidated = await revalidateReviewArtifact(artifact, { mode: 'instruction' })
  assert.equal(revalidated.valid, false)
  assert.equal(revalidated.stale, true)
})

// --- Row 26: the HTML tracker below is the bound reader's own context machine, not a
// copy. This pins the shared helper to lint's verdict: every canonical heading or task
// row the tracker marks hidden must be refused, and nothing else may be.
test('the HTML context tracker is shared with the bound reader, not a drifting copy', () => {
  assert.equal(typeof instructionHtmlLines, 'function')
  let fixtures = 0
  for (const [name, lines] of [...HTML_DIVERGENT, ...HTML_LEGAL]) {
    for (const eol of ['\n', '\r\n']) {
      const content = lines.join(eol)
      fixtures += 1
      const model = parsePlanDocument(content)
      // The tracker receives the same line array lint's scanner sees: LF-split with a
      // retained (or already stripped) CR. It strips one trailing CR itself.
      const hidden = instructionHtmlLines(content.split('\n'))
      const expected = [
        ...model.sections.filter(section => hidden[section.line - 1]).map(section => 'SECTION_HTML_BLOCK@' + section.line),
        ...model.tasks.filter(task => hidden[task.line - 1]).map(task => 'TASK_ROW_HTML_BLOCK@' + task.line),
        ...model.outOfSection.filter(task => hidden[task.line - 1]).map(task => 'TASK_ROW_HTML_BLOCK@' + task.line),
      ].sort()
      const actual = lintPlan({ content }).diagnostics
        .filter(diagnostic => diagnostic.code === 'SECTION_HTML_BLOCK' || diagnostic.code === 'TASK_ROW_HTML_BLOCK')
        .map(diagnostic => diagnostic.code + '@' + diagnostic.line)
        .sort()
      assert.deepEqual(actual, expected, name + ' ' + JSON.stringify(eol) + ': hidden flags and lint diagnostics must agree')
    }
  }
  assert.equal(fixtures, 44, 'HTML corpus x LF/CRLF')
  // A line the tracker marks hidden is exactly what makes the legal tick stale: the
  // artifact refuses to normalize it, which is why lint must refuse the plan.
  const content = ROW_IN_DIV.join('\n')
  const hidden = instructionHtmlLines(content.split('\n'))
  assert.equal(hidden[2], true, 'the row at line 3 is inside the div for the tracker')
  assert.notEqual(computeInstructionSha256(applyTick(content, '1', 'x').content), computeInstructionSha256(content))
})
