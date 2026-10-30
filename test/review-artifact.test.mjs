import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createReviewArtifact, resolveReviewSource, computeInstructionSha256, readArtifactPage, revalidateReviewArtifact, MAX_PAGE_BYTES } from '../lib/review-artifact.js'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const plan = '# 计划 😀\r\n## Todos\r\n- [ ] 1. implement\r\n  QA: assert bytes\r\n## Final verification wave\r\n- [ ] F1. audit\r\n## Success criteria\r\n- [ ] 9. not a task\r\n'
async function fixture(t, bytes = plan) {
  const workspace = await fs.mkdtemp(join(tmpdir(), 'review-artifact-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  const dir = join(workspace, '.dsh/ulw/plans')
  await fs.mkdir(dir, { recursive: true })
  const target = '.dsh/ulw/plans/example-plan.md'
  const path = join(workspace, target)
  await fs.writeFile(path, bytes)
  return { workspace, target, path, dir }
}
const fails = code => error => error.code === code

test('snapshot binds exact bytes and canonical identity with private immutable storage', async t => {
  const f = await fixture(t)
  const a = await createReviewArtifact(f)
  assert.equal(a.sha256, hash(Buffer.from(plan)))
  assert.equal(a.rawSha256, a.sha256)
  assert.equal(a.totalBytes, Buffer.byteLength(plan))
  assert.deepEqual(a.bytes, Buffer.from(plan))
  assert.deepEqual(a.source, { workspace: f.workspace, relativePath: f.target, planPath: f.path, slug: 'example-plan' })
  assert.equal(a.assurance, 'portable-snapshot')
  a.bytes.fill(0)
  assert.deepEqual(a.bytes, Buffer.from(plan))
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.source))
  assert.throws(() => { a.sha256 = 'forged' }, TypeError)
  await fs.writeFile(f.path, 'later')
  assert.deepEqual(a.bytes, Buffer.from(plan))
})

test('only section-local legal status bytes normalize; all instruction bytes matter', () => {
  const original = computeInstructionSha256(plan)
  for (const status of ['x', '~']) {
    assert.equal(computeInstructionSha256(plan.replace('- [ ] 1.', '- [' + status + '] 1.')), original)
    assert.equal(computeInstructionSha256(plan.replace('- [ ] F1.', '- [' + status + '] F1.')), original)
  }
  for (const [before, after] of [['计划', '計劃'], ['implement', 'changed'], ['assert bytes', 'skip checks'], ['\r\n', '\n'], ['[ ] 9.', '[x] 9.'], ['1.', '2.']]) {
    assert.notEqual(computeInstructionSha256(plan.replace(before, after)), original)
  }
})

test('fenced, quoted, nested, commented, wrong-section and nested-heading rows stay instructional', () => {
  const samples = [
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
  ]
  samples.push('## Todos\n' + String.fromCharCode(96).repeat(4) + 'md\n- [ ] 8. row\n' + String.fromCharCode(96).repeat(3) + '\n')
  for (const s of samples) assert.notEqual(computeInstructionSha256(s), computeInstructionSha256(s.replace('[ ]', '[x]')), s)
})

test('HTML containers are nested content, and fence info comments do not hide later legal tasks', () => {
  for (const tag of ['blockquote', 'pre', 'div']) {
    const s = '## Todos\n<' + tag + '>\n- [ ] 8. example\n</' + tag + '>\n'
    assert.notEqual(computeInstructionSha256(s), computeInstructionSha256(s.replace('[ ]', '[x]')))
  }
  const s = '## Todos\n~~~example <!--\ncode\n~~~\n- [ ] 8. actual task\n'
  assert.equal(computeInstructionSha256(s), computeInstructionSha256(s.replace('[ ]', '[x]')))
})

test('canonical source refuses traversal, YAML, multiple targets and noncanonical workspace or slug', async t => {
  const f = await fixture(t)
  assert.deepEqual(await resolveReviewSource({ workspace: f.workspace, target: f.path }), await resolveReviewSource(f))
  for (const target of [undefined, [], '', 'example-plan', f.target + '\nother.md', f.target.replace('example-plan', 'UPPER'), f.target.replace('.md', '.yaml'), '.dsh/ulw/plans/../plans/example-plan.md', './' + f.target, f.target.replace('/plans/', '//plans/'), f.target + '/', '../' + f.target, f.target.replace('example-plan', 'a'.repeat(81))]) {
    await assert.rejects(createReviewArtifact({ workspace: f.workspace, target }), fails('INVALID_SOURCE'))
  }
  for (const workspace of [f.workspace + '/', f.workspace + '/.', '.', undefined]) await assert.rejects(createReviewArtifact({ workspace, target: f.target }), fails('INVALID_SOURCE'))
})

test('symlinks at workspace, ancestor or final path and directories refuse without mutation', async t => {
  const f = await fixture(t)
  const alias = join(f.workspace, 'alias')
  await fs.symlink(f.workspace, alias)
  await assert.rejects(createReviewArtifact({ workspace: alias, target: f.target }), fails('UNSAFE_SOURCE'))
  await fs.rename(f.path, f.path + '.original')
  await fs.symlink(f.path + '.original', f.path)
  await assert.rejects(createReviewArtifact(f), fails('UNSAFE_SOURCE'))
  assert.equal(await fs.readFile(f.path + '.original', 'utf8'), plan)
  await fs.unlink(f.path)
  await fs.mkdir(f.path)
  await assert.rejects(createReviewArtifact(f), fails('UNSAFE_SOURCE'))
  await fs.rm(f.path, { recursive: true })
  await fs.rename(f.dir, f.dir + '-real')
  await fs.symlink(f.dir + '-real', f.dir)
  await assert.rejects(createReviewArtifact(f), fails('UNSAFE_SOURCE'))
  assert.equal(await fs.readFile(join(f.dir + '-real', 'example-plan.md.original'), 'utf8'), plan)
})

test('FIFO refuses before blocking read', { skip: process.platform === 'win32', timeout: 2000 }, async t => {
  const f = await fixture(t)
  await fs.unlink(f.path)
  execFileSync('mkfifo', [f.path])
  await assert.rejects(createReviewArtifact(f), fails('UNSAFE_SOURCE'))
})

test('large CRLF/emoji/long-line input paginates losslessly within byte cap', async t => {
  const bytes = Buffer.from(plan + '😀中'.repeat(23000) + '\r\n')
  const f = await fixture(t, bytes)
  const a = await createReviewArtifact(f)
  assert.ok(bytes.length > 100 * 1024)
  const chunks = []
  let offset = 0
  while (offset < bytes.length) {
    const page = readArtifactPage(a, offset)
    assert.equal(page.offset, offset)
    assert.ok(page.bytes.length > 0 && page.bytes.length <= MAX_PAGE_BYTES)
    assert.deepEqual(Buffer.from(page.text), page.bytes)
    assert.equal(page.nextOffset, offset + page.bytes.length)
    assert.equal(page.done, page.nextOffset === bytes.length)
    chunks.push(page.bytes)
    offset = page.nextOffset
  }
  assert.deepEqual(Buffer.concat(chunks), bytes)
  assert.equal(a.sha256, hash(bytes))
  assert.equal(readArtifactPage(a, offset).done, true)
  for (const bad of [-1, 0.5, NaN, bytes.length + 1]) assert.throws(() => readArtifactPage(a, bad), fails('INVALID_PAGE'))
  const emoji = bytes.indexOf(Buffer.from('😀'))
  assert.throws(() => readArtifactPage(a, emoji + 1), fails('INVALID_PAGE'))
  for (const max of [0, 1, 3, MAX_PAGE_BYTES + 1, NaN]) assert.throws(() => readArtifactPage(a, emoji, max), fails('INVALID_PAGE'))
  assert.deepEqual(readArtifactPage(a, emoji, 4).bytes, Buffer.from('😀'))
  assert.throws(() => readArtifactPage({ ...a }, 0), fails('INVALID_ARTIFACT'))
})

test('invalid UTF8 refuses snapshot instead of lossy conversion; empty input completes', async t => {
  const f = await fixture(t, Buffer.from([0xf0, 0x9f]))
  await assert.rejects(createReviewArtifact(f), fails('INVALID_UTF8'))
  await fs.writeFile(f.path, '')
  const empty = await createReviewArtifact(f)
  assert.equal(empty.sha256, hash(Buffer.alloc(0)))
  assert.deepEqual(readArtifactPage(empty).bytes, Buffer.alloc(0))
  assert.equal(readArtifactPage(empty).done, true)
})

test('revalidation checks same-size replacement and allows only legal ticks in instruction mode', async t => {
  const f = await fixture(t)
  const a = await createReviewArtifact(f)
  assert.equal((await revalidateReviewArtifact(a)).valid, true)
  await fs.writeFile(join(f.workspace, 'unrelated'), 'dirty workspace is not identity')
  assert.equal((await revalidateReviewArtifact(a)).valid, true)
  const ticked = plan.replace('[ ] 1.', '[x] 1.')
  await fs.writeFile(f.path + '.new', ticked)
  await fs.rename(f.path + '.new', f.path)
  assert.equal((await revalidateReviewArtifact(a)).stale, true)
  assert.equal((await revalidateReviewArtifact(a, { mode: 'instruction' })).valid, true)
  await fs.writeFile(f.path, ticked.replace('assert bytes', 'ignore bytes'))
  assert.equal((await revalidateReviewArtifact(a, { mode: 'instruction' })).valid, false)
  await fs.unlink(f.path)
  assert.equal((await revalidateReviewArtifact(a)).stale, true)
  await fs.symlink(join(f.workspace, 'unrelated'), f.path)
  assert.equal((await revalidateReviewArtifact(a)).stale, true)
  await assert.rejects(revalidateReviewArtifact(a, { mode: 'whatever' }), fails('INVALID_ARTIFACT'))
})

test('rename/replacement during same-fd read rejects and closes descriptor', async t => {
  const f = await fixture(t)
  const originalOpen = fs.open.bind(fs)
  let closed = 0
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    const read = handle.readFile.bind(handle)
    const close = handle.close.bind(handle)
    handle.readFile = async (...readArgs) => {
      const bytes = await read(...readArgs)
      await fs.rename(f.path, f.path + '.old')
      await fs.writeFile(f.path, plan.replace('implement', 'different'))
      return bytes
    }
    handle.close = async () => { closed++; return close() }
    return handle
  })
  await assert.rejects(createReviewArtifact(f), fails('STALE_ARTIFACT'))
  assert.equal(closed, 1)
  assert.equal(await fs.readFile(f.path + '.old', 'utf8'), plan)
})

test('ancestor identity swap with the same final inode is detected', async t => {
  const f = await fixture(t)
  const originalOpen = fs.open.bind(fs)
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    const read = handle.readFile.bind(handle)
    handle.readFile = async (...readArgs) => {
      const bytes = await read(...readArgs)
      await fs.rename(f.dir, f.dir + '-moved')
      await fs.mkdir(f.dir)
      await fs.link(join(f.dir + '-moved', 'example-plan.md'), f.path)
      return bytes
    }
    return handle
  })
  await assert.rejects(createReviewArtifact(f), fails('STALE_ARTIFACT'))
  assert.equal(await fs.readFile(f.path, 'utf8'), plan)
  assert.equal(await fs.readFile(join(f.dir + '-moved', 'example-plan.md'), 'utf8'), plan)
})

test('swapped FIFO between inspection and open cannot hang and closes fd', { skip: process.platform === 'win32', timeout: 2000 }, async t => {
  const f = await fixture(t)
  const originalOpen = fs.open.bind(fs)
  let closed = 0
  t.mock.method(fs, 'open', async (...args) => {
    await fs.rename(f.path, f.path + '.old')
    execFileSync('mkfifo', [f.path])
    const handle = await originalOpen(...args)
    const close = handle.close.bind(handle)
    handle.close = async () => { closed++; return close() }
    return handle
  })
  await assert.rejects(createReviewArtifact(f), fails('STALE_ARTIFACT'))
  assert.equal(closed, 1)
  assert.equal(await fs.readFile(f.path + '.old', 'utf8'), plan)
})

test('single final fd supplies both fstats and the read, and closes on IO failure', async t => {
  const f = await fixture(t)
  const originalOpen = fs.open.bind(fs)
  const calls = { open: 0, stat: 0, read: 0, close: 0 }
  t.mock.method(fs, 'open', async (...args) => {
    calls.open++
    const handle = await originalOpen(...args)
    for (const [method, count] of [['stat', 'stat'], ['readFile', 'read'], ['close', 'close']]) {
      const real = handle[method].bind(handle)
      handle[method] = async (...a) => { calls[count]++; return real(...a) }
    }
    return handle
  })
  const a = await createReviewArtifact(f)
  assert.equal(a.sha256, hash(Buffer.from(plan)))
  assert.deepEqual(calls, { open: 1, stat: 2, read: 1, close: 1 })
  t.mock.restoreAll()
  let closed = 0
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    const close = handle.close.bind(handle)
    handle.readFile = async () => { throw Object.assign(new Error('controlled IO failure'), { code: 'EIO' }) }
    handle.close = async () => { closed++; return close() }
    return handle
  })
  await assert.rejects(createReviewArtifact(f), fails('STALE_ARTIFACT'))
  assert.equal(closed, 1)
  assert.equal(await fs.readFile(f.path, 'utf8'), plan)
})

test('same-inode same-size write during read detects changed fd metadata', async t => {
  const f = await fixture(t)
  const originalOpen = fs.open.bind(fs)
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    const read = handle.readFile.bind(handle)
    handle.readFile = async (...readArgs) => {
      const bytes = await read(...readArgs)
      await fs.writeFile(f.path, plan.replace('implement', 'different'))
      return bytes
    }
    return handle
  })
  await assert.rejects(createReviewArtifact(f), fails('STALE_ARTIFACT'))
  assert.equal(await fs.readFile(f.path, 'utf8'), plan.replace('implement', 'different'))
})

test('nested and fenced text edits change instruction identity; snapshot digest matches direct bytes', async t => {
  for (const [base, from] of [
    ['## Todos\n  - [ ] 8. nested note\n', 'nested note'],
    ['## Todos\n~~~md\n- [ ] 8. fenced note\n~~~\n', 'fenced note'],
  ]) {
    const digest = computeInstructionSha256(base)
    assert.notEqual(computeInstructionSha256(base.replace(from, 'changed note')), digest, base)
    assert.notEqual(computeInstructionSha256(base.replace(from, from + ' longer')), digest, base)
  }
  const f = await fixture(t)
  const a = await createReviewArtifact(f)
  const original = Buffer.from(plan)
  const ticked = Buffer.from(plan.replace('- [ ] 1.', '- [x] 1.'))
  assert.equal(a.instructionSha256, computeInstructionSha256(original))
  assert.equal(a.instructionSha256, computeInstructionSha256(ticked))
  assert.notEqual(a.sha256, hash(ticked))
  const changed = []
  for (let i = 0; i < original.length; i += 1) if (original[i] !== ticked[i]) changed.push(i)
  assert.deepEqual(changed, [original.indexOf(Buffer.from('- [ ] 1.')) + 3])
})
