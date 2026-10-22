/**
 * Asset loading and skill registration shape: frontmatter stripping, the
 * artifact-root transform, and the two published skills.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSkill, parseFrontmatter, renameArtifacts } from '../lib/load.js'

test('frontmatter scalars are parsed and the body excludes the block', () => {
  const text = '---\nname: demo\ndescription: "quoted: value"\nmetadata:\n  short-description: nested\n---\n\n# Body\n'
  const { data, content } = parseFrontmatter(text)
  assert.equal(data.name, 'demo')
  assert.equal(data.description, 'quoted: value')
  assert.equal('short-description' in data, false)
  assert.equal(content, '\n# Body\n')
})

test('a file without frontmatter is returned unchanged', () => {
  assert.deepEqual(parseFrontmatter('# Body\n'), { data: {}, content: '# Body\n' })
})

test('the runtime artifact transform is the single rename', () => {
  assert.equal(renameArtifacts('write .omo/plans/a.md'), 'write .dsh/ulw/plans/a.md')
  assert.equal(renameArtifacts('.dsh/ulw/plans/a.md'), '.dsh/ulw/plans/a.md')
})

test('both skills load with frontmatter identity and an absolute resource base', () => {
  for (const directory of ['ulw-plan', 'ulw-execute']) {
    const skill = loadSkill(directory)
    assert.equal(skill.name, directory)
    assert.equal(skill.description.length > 0, true)
    assert.equal(skill.content.startsWith('---'), false)
    assert.equal(skill.content.includes('.omo'), false)
    assert.equal(skill.resourceBase.kind, 'directory')
    assert.equal(skill.resourceBase.path.endsWith(`/skills/${directory}`), true)
  }
})

test('the ulw-plan body keeps its mandatory marker and script call', () => {
  const skill = loadSkill('ulw-plan')
  assert.equal(skill.content.includes('ULW-PLAN MODE ENABLED!'), true)
  assert.equal(skill.content.includes('scripts/scaffold-plan.mjs'), true)
  assert.equal(skill.content.includes('.dsh/ulw/'), true)
})
