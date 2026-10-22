/**
 * Containment tests for the artifact root: relative/absolute paths, `..`
 * escapes, symlinked components, and the artifact-existence probe.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactPath, artifactRoot, hasUlwArtifact, isUnderArtifactRoot } from '../lib/paths.js'

const workspace = () => mkdtempSync(join(tmpdir(), 'dsh-omo-paths-'))

test('the artifact root is .dsh/ulw under the working directory', () => {
  const cwd = workspace()
  assert.equal(artifactRoot(cwd), join(cwd, '.dsh', 'ulw'))
  assert.equal(artifactPath(cwd, 'plans', 'x.md'), join(cwd, '.dsh', 'ulw', 'plans', 'x.md'))
})

test('relative and absolute artifact paths are allowed', () => {
  const cwd = workspace()
  assert.equal(isUnderArtifactRoot(cwd, '.dsh/ulw/plans/x.md'), true)
  assert.equal(isUnderArtifactRoot(cwd, join(cwd, '.dsh', 'ulw', 'drafts', 'x.md')), true)
})

test('product paths and traversal are refused', () => {
  const cwd = workspace()
  for (const target of ['src/main.ts', '../outside.md', '.dsh/ulw/../secret.md', '.dsh/other/x.md', '/etc/passwd']) {
    assert.equal(isUnderArtifactRoot(cwd, target), false, target)
  }
})

test('an empty or non-string target is refused', () => {
  const cwd = workspace()
  assert.equal(isUnderArtifactRoot(cwd, ''), false)
  assert.equal(isUnderArtifactRoot(cwd, undefined), false)
})

test('a symlinked artifact directory is refused', () => {
  const cwd = workspace()
  const outside = workspace()
  symlinkSync(outside, join(cwd, '.dsh'), 'dir')
  assert.equal(isUnderArtifactRoot(cwd, '.dsh/ulw/plans/x.md'), false)
})

test('a symlinked file inside the artifact root is refused', () => {
  const cwd = workspace()
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  const real = join(cwd, 'real.md')
  writeFileSync(real, '# real')
  symlinkSync(real, join(cwd, '.dsh', 'ulw', 'plans', 'link.md'))
  assert.equal(isUnderArtifactRoot(cwd, '.dsh/ulw/plans/link.md'), false)
})

test('a missing artifact root is still writable', () => {
  const cwd = workspace()
  assert.equal(isUnderArtifactRoot(cwd, '.dsh/ulw/plans/new.md'), true)
})

test('artifact detection sees markdown drafts and plans only', () => {
  const cwd = workspace()
  assert.equal(hasUlwArtifact(cwd), false)
  mkdirSync(join(cwd, '.dsh', 'ulw', 'drafts'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'drafts', 'notes.txt'), 'not a draft')
  assert.equal(hasUlwArtifact(cwd), false)
  writeFileSync(join(cwd, '.dsh', 'ulw', 'drafts', 'plan.md'), '# draft')
  assert.equal(hasUlwArtifact(cwd), true)
})
