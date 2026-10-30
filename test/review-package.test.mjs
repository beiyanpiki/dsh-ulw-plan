/**
 * Distribution contract for ULW plan row 17.
 *
 * The test asserts the published metadata, the real npm pack file list, the
 * documented review configuration against the same pure parser the Host uses,
 * and that a copy made only of packed files still resolves its entry and
 * assets. It never imports from the installed DSH checkout and never calls a
 * model.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { normalizeModelId, parseReviewConfig } from '../lib/review-config.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))
const pkg = readJson('package.json')

/** Run npm pack without touching the user cache or the network. */
function packList() {
  const cache = mkdtempSync(join(tmpdir(), 'dsh-ulw-pack-'))
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const output = execFileSync(npm, ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: cache,
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_progress: 'false',
      },
    })
    const parsed = JSON.parse(output)
    const entry = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
    assert.ok(entry && Array.isArray(entry.files), 'npm pack --dry-run --json returned no file list')
    return { entry, files: entry.files.map((file) => file.path) }
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}

let packed
const packedFiles = () => {
  packed ??= packList()
  return packed
}

/** Parse the small YAML subset used by the documented patch example. */
function yamlSubset(text) {
  const root = []
  const stack = []
  const scalar = (value) => {
    const token = value.trim()
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1)
    if (token === 'true') return true
    if (token === 'false') return false
    if (/^-?[0-9]+$/.test(token)) return Number(token)
    return token
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack.length === 0 ? root : stack[stack.length - 1].value
    if (line.startsWith('- ')) {
      const rest = line.slice(2).trim()
      const item = {}
      assert.ok(Array.isArray(parent), 'yaml subset: list item outside a list')
      parent.push(item)
      stack.push({ indent, value: item })
      if (rest.endsWith(':')) {
        const key = rest.slice(0, -1).trim()
        item[key] = {}
        stack.push({ indent: indent + 2, value: item[key] })
      } else {
        const split = rest.indexOf(':')
        item[rest.slice(0, split).trim()] = scalar(rest.slice(split + 1))
      }
      continue
    }
    const split = line.indexOf(':')
    assert.ok(split > 0, 'yaml subset: expected key: value')
    const key = line.slice(0, split).trim()
    const value = line.slice(split + 1).trim()
    assert.equal(Array.isArray(parent), false, 'yaml subset: mapping key inside a list')
    if (value === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, value: child })
    } else {
      parent[key] = scalar(value)
    }
  }
  return root
}

/** Extract and parse the marked review example from a README text. */
function documentedExample(readme) {
  const start = readme.indexOf('<!-- review-config:start -->')
  const end = readme.indexOf('<!-- review-config:end -->')
  assert.ok(start >= 0 && end > start, 'README has no marked review config example')
  const block = readme.slice(start, end)
  const fenced = /[\x60]{3}ya?ml\r?\n([\s\S]*?)[\x60]{3}/.exec(block)
  assert.ok(fenced, 'the marked example is not a fenced yaml block')
  const rows = yamlSubset(fenced[1])
  assert.equal(rows.length, 1, 'the documented patch must contain exactly one row')
  assert.equal(rows[0].id, 'omo')
  assert.equal(rows[0].name, 'dsh-ulw-plan')
  return rows[0].config.review
}

test('published metadata keeps the package identity and the Host bundle row', () => {
  assert.equal(pkg.name, 'dsh-ulw-plan')
  assert.equal(pkg.version, '0.1.0')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.main, './lib/index.js')
  assert.ok(existsSync(join(ROOT, pkg.main)), 'main entry is missing')
  assert.deepEqual(pkg.exports, {
    '.': './lib/index.js',
    './icon': './icon.svg',
    './locale/*.json': './locale/*.json',
    './package.json': './package.json',
  })
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')), 'bundle patch is missing')
  assert.ok(existsSync(join(ROOT, pkg.icon)), 'package icon is missing')
  assert.deepEqual(pkg.files, [
    'lib/',
    'skills/',
    'locale/',
    'docs/fidelity.md',
    'docs/publishing.md',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'LICENSE',
  ])
  assert.match(pkg.engines.node, /^>=22/)
  assert.equal(pkg.engines.dsh, '>=0.2.0-rc.2')
  assert.match(pkg.description, /review/i)
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[field], undefined, field + ' must stay absent: zero production dependencies')
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(pkg.scripts?.[hook], undefined, hook + ' must not exist: zero build step')
  }
  assert.equal(pkg.scripts?.test, 'node --test')
})

test('the bundle patch keeps exactly one Host row with the omo id', () => {
  const patch = read('cordis.patch.yml')
  assert.equal((patch.match(/^-\s*insert:\s*$/gm) ?? []).length, 1)
  assert.equal((patch.match(/^\s*-\s*id:\s*omo\s*$/gm) ?? []).length, 1)
  assert.equal((patch.match(/^\s*name:\s*dsh-ulw-plan\s*$/gm) ?? []).length, 1)
  assert.equal(patch.includes('config:'), false, 'the bundle must not authorize review routes; users configure the review block in their profile patch layer')
})

test('the npm pack list contains every runtime file and no private paths', () => {
  const { entry, files } = packedFiles()
  assert.equal(entry.name, pkg.name)
  assert.equal(entry.version, pkg.version)
  assert.ok(files.length > 0)
  assert.equal(new Set(files).size, files.length, 'duplicate pack entries')
  for (const file of files) {
    assert.equal(file.startsWith('/'), false, file + ' is an absolute path')
    assert.equal(file.includes('\\'), false, file + ' uses a backslash')
    assert.equal(file.includes('..'), false, file + ' escapes the package root')
  }
  const libModules = readdirSync(join(ROOT, 'lib')).filter((name) => name.endsWith('.js')).map((name) => 'lib/' + name)
  const required = [
    'package.json',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'LICENSE',
    'locale/en.json',
    'locale/zh.json',
    'docs/fidelity.md',
    'docs/publishing.md',
    'skills/ulw-plan/SKILL.md',
    'skills/ulw-execute/SKILL.md',
    'skills/ulw-plan/references/plan-reviewer.md',
    'skills/ulw-plan/references/plan-adversarial-reviewer.md',
    'skills/ulw-plan/references/plan-consultant.md',
    'skills/ulw-plan/references/full-workflow.md',
    'skills/ulw-plan/references/intent-clear.md',
    'skills/ulw-plan/references/intent-unclear.md',
    'skills/ulw-plan/references/research-lanes.md',
    'skills/ulw-plan/references/dsh-harness.md',
    'skills/ulw-plan/scripts/plan-lint.mjs',
    'skills/ulw-plan/scripts/plan-templates.mjs',
    'skills/ulw-plan/scripts/scaffold-plan.mjs',
    'skills/ulw-execute/scripts/plan-state.mjs',
    ...libModules,
  ]
  for (const file of required) assert.ok(files.includes(file), 'pack is missing ' + file)
  for (const file of files) {
    for (const prefix of ['test/', 'qa/', '.dsh/', '.vendor/', 'node_modules/', '.github/']) {
      assert.equal(file.startsWith(prefix), false, file + ' must not ship')
    }
    assert.equal(file.endsWith('.tgz'), false, file + ' must not ship a tarball')
  }
  assert.equal(files.includes('docs/migration-plan.md'), false, 'the internal migration note (host paths) must not ship')
  for (const file of files) {
    const text = read(file)
    assert.equal(text.includes('/home/miku'), false, file + ' embeds the host account path')
    assert.equal(/[A-Za-z]:\\Users\\/.test(text), false, file + ' embeds a Windows user path')
    assert.equal(/apiKey\s*[:=]|secret\s*[:=]|password\s*[:=]|sk-[A-Za-z0-9]{16,}/i.test(text), false, file + ' looks like it embeds credentials')
  }
  for (const file of ['package.json', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json']) {
    assert.equal(/\/(?:home|Users)\//.test(read(file)), false, file + ' embeds an absolute local path')
  }
})

test('the documented review example parses and invalid variants are rejected', () => {
  const review = documentedExample(read('README.md'))
  assert.equal(review.enabled, true)
  const parsed = parseReviewConfig(review)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.storageBackend, 'json')
  assert.equal(parsed.backend, 'spawn')
  assert.equal(parsed.callBudget, 4)
  assert.deepEqual(Object.keys(parsed.lanes).sort(), ['adversarial', 'practical'])
  assert.equal(parsed.lanes.practical.provider, 'deepseek')
  assert.equal(parsed.lanes.practical.model, 'deepseek-chat')
  assert.equal(parsed.lanes.practical.maxTokens, 4096)
  assert.equal(parsed.lanes.adversarial.reasoningEffort, 'high')
  assert.notEqual(normalizeModelId(parsed.lanes.practical.model), normalizeModelId(parsed.lanes.adversarial.model))
  assert.deepEqual(parseReviewConfig({}), { enabled: false, storageBackend: 'json', backend: 'spawn', callBudget: 0, lanes: {} })
  const readme = read('README.md')
  assert.match(readme, /enabled: false/, 'README must show the safe default-off config')
  assert.match(readme, /0\.2\.1-rc\.4/, 'README must state the verified DSH version')
  assert.match(readme, /GUI[\s\S]*allowlist|allowlist[\s\S]*GUI/, 'README must explain the GUI allowlist boundary')
  assert.equal(/sk-[A-Za-z0-9]{16,}|apiKey\s*:/.test(JSON.stringify(review)), false, 'the documented example must stay key-free')
  assert.throws(() => parseReviewConfig({ ...review, callBudget: 3 }), (error) => error.code === 'BUDGET_EXHAUSTED')
  const sameModel = {
    ...review,
    lanes: {
      practical: { provider: 'provider-a', model: 'same-model', maxTokens: 10 },
      adversarial: { provider: 'provider-b', model: 'same-model', maxTokens: 10 },
    },
  }
  assert.throws(() => parseReviewConfig(sameModel), (error) => error.code === 'ROUTE_UNAUTHORIZED')
  assert.throws(() => parseReviewConfig({ enabled: true }), (error) => error.code === 'BUDGET_EXHAUSTED')
  assert.throws(() => parseReviewConfig({ ...review, unexpected: true }), (error) => error.code === 'INVALID_CONFIG')
})

test('English and Chinese locale metadata stay in sync', () => {
  const en = readJson('locale/en.json')
  const zh = readJson('locale/zh.json')
  assert.deepEqual(Object.keys(en), Object.keys(zh))
  assert.deepEqual(Object.keys(en.meta), Object.keys(zh.meta))
  for (const locale of [en, zh]) {
    assert.ok(locale.meta.title.trim().length > 0)
    assert.ok(locale.meta.description.trim().length > 0)
    assert.match(locale.meta.description, /\/ulw-review/)
    assert.match(locale.meta.description, /ulw_review/)
    assert.match(locale.meta.description, /ulw_handoff/)
  }
  assert.notEqual(en.meta.title, zh.meta.title)
})

test('the packed runtime resolves from an isolated tarball root', async () => {
  const { files } = packedFiles()
  const isolated = mkdtempSync(join(tmpdir(), 'dsh-ulw-isolated-'))
  try {
    for (const file of files) {
      const target = join(isolated, file)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(ROOT, file), target)
    }
    for (const entry of ['package.json', 'lib/index.js', 'skills/ulw-plan/SKILL.md', 'icon.svg']) {
      assert.ok(existsSync(join(isolated, entry)), 'isolated copy is missing ' + entry)
    }
    const entry = await import(pathToFileURL(join(isolated, 'lib/index.js')).href)
    assert.equal(entry.name, 'dsh-ulw-plan')
    assert.equal(typeof entry.apply, 'function')
    assert.ok(Array.isArray(entry.inject) && entry.inject.includes('tools'))
    const load = await import(pathToFileURL(join(isolated, 'lib/load.js')).href)
    const skill = load.loadSkill('ulw-plan')
    assert.equal(skill.name, 'ulw-plan')
    assert.match(skill.content, /ULW-PLAN MODE ENABLED!/)
    assert.equal(skill.content.includes('.omo'), false)
    assert.ok(load.readAsset('skills/ulw-plan/references/plan-reviewer.md').length > 0)
    assert.ok(load.readAsset('skills/ulw-plan/references/plan-adversarial-reviewer.md').length > 0)
    const config = await import(pathToFileURL(join(isolated, 'lib/review-config.js')).href)
    const review = documentedExample(load.readAsset('README.md'))
    assert.equal(config.parseReviewConfig(review).enabled, true)
  } finally {
    rmSync(isolated, { recursive: true, force: true })
  }
})
