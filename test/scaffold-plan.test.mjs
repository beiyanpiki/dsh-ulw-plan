import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { isCanonicalPlanSlug } from '../lib/review-lint.js'
import { computeInstructionSha256, createReviewArtifact, revalidateReviewArtifact } from '../lib/review-artifact.js'
import { parseArgs } from '../skills/ulw-plan/scripts/scaffold-plan.mjs'

const SCAFFOLD = fileURLToPath(new URL('../skills/ulw-plan/scripts/scaffold-plan.mjs', import.meta.url))
const PLAN_STATE = fileURLToPath(new URL('../skills/ulw-execute/scripts/plan-state.mjs', import.meta.url))
const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
const parse = slug => parseArgs(['node', 'scaffold-plan.mjs', slug])
async function workspace(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'scaffold-plan-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('scaffold slug grammar is the canonical review grammar, not a looser hyphen shape', () => {
  for (const slug of ['a', 'a-b', 'a1-b2', '1', '0', 'a'.repeat(80), 'a'.repeat(78) + '-b']) assert.equal(parse(slug).slug, slug)
  for (const slug of ['a--b', 'a-', '-a', '--a', 'a--', 'a_b', 'a.b', 'A-b', 'aB', 'ä-b', 'a b', 'a\tb', 'a\nb', 'a\n', 'a'.repeat(81), '']) {
    assert.throws(() => parse(slug), error => /invalid slug|unknown flag|usage/.test(error.message), JSON.stringify(slug))
  }
})

test('scaffold accepts exactly the slugs review-lint calls canonical', () => {
  const matrix = ['a', 'a-b', 'a1-b2', '1', 'a--b', 'a-', '-a', 'A-b', 'a_b', 'a.b', 'ä-b', 'a b', 'a'.repeat(80), 'a'.repeat(81), 'a\n']
  for (const slug of matrix) {
    let accepted = true
    try { parse(slug) } catch { accepted = false }
    assert.equal(accepted, isCanonicalPlanSlug(slug), JSON.stringify(slug))
  }
})

test('scaffold CLI refuses a--b and a- with a nonzero exit and writes nothing', async t => {
  const cwd = await workspace(t)
  for (const slug of ['a--b', 'a-']) {
    const result = run(SCAFFOLD, [slug], cwd)
    assert.equal(result.status, 1, slug)
    assert.match(result.stderr, /invalid slug/, slug)
  }
  await assert.rejects(fs.stat(join(cwd, '.dsh')), { code: 'ENOENT' })
})

test('a scaffolded canonical plan takes a legal H3 tick without changing instruction identity', async t => {
  const cwd = await workspace(t)
  const target = '.dsh/ulw/plans/a-b.md'
  const made = run(SCAFFOLD, ['a-b'], cwd)
  assert.equal(made.status, 0, made.stderr)
  assert.match(made.stdout, /created: \.dsh\/ulw\/plans\/a-b\.md/)
  const path = join(cwd, target)
  const skeleton = await fs.readFile(path, 'utf8')
  const withH3 = skeleton.replace('## Todos\n', '## Todos\n### Notes\n')
  assert.notEqual(withH3, skeleton)
  await fs.writeFile(path, withH3)
  const artifact = await createReviewArtifact({ workspace: cwd, target })
  const before = computeInstructionSha256(withH3)
  assert.equal(artifact.instructionSha256, before)
  const tick = run(PLAN_STATE, ['tick', path, '1'], cwd)
  assert.equal(tick.status, 0, tick.stderr)
  assert.match(tick.stdout, /ticked 1 x/)
  const after = await fs.readFile(path, 'utf8')
  assert.equal(computeInstructionSha256(after), before)
  assert.equal((await revalidateReviewArtifact(artifact, { mode: 'instruction' })).valid, true)
  assert.equal((await revalidateReviewArtifact(artifact)).stale, true)
  const edited = after.replace('1. <title>', '1. <title> changed after H3')
  assert.notEqual(edited, after)
  await fs.writeFile(path, edited)
  assert.notEqual(computeInstructionSha256(edited), before)
  assert.equal((await revalidateReviewArtifact(artifact, { mode: 'instruction' })).valid, false)
})
