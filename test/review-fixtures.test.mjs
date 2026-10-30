/**
 * Clean/bad plan corpus and its evaluation truth manifest.
 *
 * test/fixtures/review/manifest.json is the machine-readable truth for a corpus of
 * self-contained plan fixtures. Each case is materialized into an independent temporary
 * repository - the plan at .dsh/ulw/plans/<slug>.md plus the local sources it cites - and
 * then checked three ways:
 *
 *   1. structural grouping: lintPlan must accept every clean case, reject every structural
 *      bad case with exactly the pinned diagnostics, and stay silent about the semantic bad
 *      cases (their defects are reviewer-only, so no warning may be promoted to a blocker);
 *   2. protocol truth: the expected blockers and notes are fed through the real
 *      validateReviewResult contract, which proves every expectation is an eligible,
 *      evidence-backed blocker and every listed note stays a non-blocking note;
 *   3. reachability: every truth evidence coordinate resolves inside the materialized
 *      repository, its marker text occurs on the cited line range, the location anchor
 *      exists in the plan, and the blocker id equals its stable derivation.
 *
 * The large UTF-8 case is built from a small committed template plus the deterministic
 * builder below; no meaningless 100 KiB duplicate is committed. Fixture sources are .txt
 * files or manifest strings, so Node's default test scanner never executes a fake source.
 *
 * Offline and deterministic: no network, no absolute machine paths in fixtures, no clock
 * or randomness. Every fixture command is described, never executed; the only child
 * process is the read-only plan-lint CLI, spawned once per case.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES, WARNING_CODES, isCanonicalPlanSlug, lintPlan, parsePlanDocument } from '../lib/review-lint.js'
import { BLOCKER_ELIGIBILITIES, validateReviewResult } from '../lib/review-protocol.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = join(HERE, 'fixtures', 'review')
const MANIFEST_PATH = join(CORPUS_DIR, 'manifest.json')
const CLI = fileURLToPath(new URL('../skills/ulw-plan/scripts/plan-lint.mjs', import.meta.url))
const CORPUS_NAME = 'ulw-review-plan-corpus'
const REPEAT_TOKEN = '%%REPEAT%%'
const LONG_TOKEN = '%%LONG%%'
const CASE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const PROTOCOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SHA_RE = /^[a-f0-9]{64}$/
const PLAN_SOURCE_RE = /^plans\/[a-z0-9][a-z0-9-]*\.plan\.txt$/
const SOURCE_RE = /^sources\/[A-Za-z0-9._-]+\.txt$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const LANES = Object.freeze(['practical', 'adversarial'])
const REQUIRED_DEFECTS = Object.freeze([
  'missing-existing-reference',
  'is-not-delivered',
  'mutually-exclusive-steps',
  'non-executable-qa',
  'external-contract-mismatch',
  'fake-okay-injection',
  'stale-summary',
  'duplicate-id',
])
const CASE_KEYS = Object.freeze(['caseId', 'classification', 'defect', 'structural', 'summary', 'plan', 'repo', 'expected'])
const PLAN_KEYS = Object.freeze(['slug', 'source', 'build'])
const BUILD_KEYS = Object.freeze(['template', 'repeat', 'lineEnding', 'longLine'])
const EXPECTED_KEYS = Object.freeze(['planSha256', 'lint', 'blockers', 'nonBlockingNotes'])
const LINT_KEYS = Object.freeze(['valid', 'errors', 'warnings'])
const ERROR_KEYS = Object.freeze(['code', 'line', 'taskId'])
const WARNING_KEYS = Object.freeze(['code'])
const BLOCKER_KEYS = Object.freeze(['id', 'lane', 'eligibility', 'location', 'evidence', 'remediation'])
const LOCATION_KEYS = Object.freeze(['taskId', 'isId', 'gapId'])
const EVIDENCE_KEYS = Object.freeze(['path', 'line', 'endLine', 'marker'])
const CONVENTION_KEYS = Object.freeze(['caseId', 'stableBlockerId', 'evidence', 'structural', 'notes'])

class CorpusError extends Error {
  constructor(code, path, message) {
    super(message + ' [' + code + ' at ' + path + ']')
    this.name = 'CorpusError'
    this.code = code
    this.path = path
  }
}

function fail(code, path, message) {
  throw new CorpusError(code, path, message)
}

function assertCorpus(condition, code, path, message) {
  if (!condition) fail(code, path, message)
  return condition
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertPlain(value, path, label) {
  assertCorpus(isPlainObject(value), 'CORPUS_SHAPE', path, label + ' must be a plain JSON object')
  return value
}

function assertKnownKeys(value, allowed, path, label) {
  for (const key of Object.keys(value)) {
    assertCorpus(allowed.includes(key), 'CORPUS_SHAPE', path + '.' + key, label + ' has unknown field ' + JSON.stringify(key))
  }
}

function isSafeRelative(value) {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('\\')) return false
  if (CONTROL_RE.test(value)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment))
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function planTargetOf(spec) {
  return '.dsh/ulw/plans/' + spec.plan.slug + '.md'
}

function anchorOf(blocker) {
  const filled = LOCATION_KEYS.filter(key => blocker.location[key] !== '')
  return filled.length === 1 ? { key: filled[0], value: blocker.location[filled[0]] } : null
}

function stableBlockerId(blocker) {
  const anchor = anchorOf(blocker)
  return anchor === null ? null : ['blk', blocker.lane, blocker.eligibility, anchor.value].join('.')
}

function toProtocolBlocker(blocker) {
  return {
    id: blocker.id,
    eligibility: blocker.eligibility,
    location: { taskId: blocker.location.taskId, isId: blocker.location.isId, gapId: blocker.location.gapId },
    evidence: blocker.evidence.map(entry => ({ path: entry.path, line: entry.line, endLine: entry.endLine })),
    remediation: blocker.remediation,
  }
}

function expectedLaneVerdict(spec, lane) {
  return spec.expected.blockers.some(blocker => blocker.lane === lane) ? 'REJECT' : 'OKAY'
}

function laneResult(spec, lane, planSha) {
  const laneBlockers = spec.expected.blockers.filter(blocker => blocker.lane === lane)
  return {
    version: 1,
    lane,
    roundId: 'corpus-round-1',
    launchId: 'corpus-launch-1',
    planSha256: planSha,
    verdict: laneBlockers.length > 0 ? 'REJECT' : 'OKAY',
    summary: spec.summary,
    blockers: laneBlockers.map(toProtocolBlocker),
    notes: spec.expected.nonBlockingNotes.slice(),
  }
}

async function readCorpusText(relative) {
  assertCorpus(isSafeRelative(relative), 'CORPUS_FILE_UNREADABLE', relative, 'corpus source path must stay inside test/fixtures/review')
  try {
    return await fs.readFile(join(CORPUS_DIR, relative), 'utf8')
  } catch (error) {
    return fail('CORPUS_FILE_UNREADABLE', relative, 'cannot read corpus source: ' + error.message)
  }
}

async function loadManifest(file = MANIFEST_PATH) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    return fail('MANIFEST_UNREADABLE', file, 'cannot read the truth manifest: ' + error.message)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    return fail('MANIFEST_MALFORMED', file, 'truth manifest is not valid JSON: ' + error.message)
  }
}

function checkPlanSpec(plan, path) {
  assertPlain(plan, path, 'plan')
  assertKnownKeys(plan, PLAN_KEYS, path, 'plan')
  assertCorpus(isCanonicalPlanSlug(plan.slug), 'SLUG_NOT_CANONICAL', path + '.slug', 'plan slug ' + JSON.stringify(plan.slug) + ' is not bindable for review')
  const hasSource = Object.hasOwn(plan, 'source')
  const hasBuild = Object.hasOwn(plan, 'build')
  assertCorpus(hasSource !== hasBuild, 'PLAN_SOURCE_INVALID', path, 'exactly one of source/build is required')
  if (hasSource) {
    assertCorpus(typeof plan.source === 'string' && PLAN_SOURCE_RE.test(plan.source), 'PLAN_SOURCE_INVALID', path + '.source', 'plan text must be a committed plans/<slug>.plan.txt file')
    return
  }
  const build = assertPlain(plan.build, path + '.build', 'build spec')
  assertKnownKeys(build, BUILD_KEYS, path + '.build', 'build spec')
  assertCorpus(typeof build.template === 'string' && PLAN_SOURCE_RE.test(build.template), 'PLAN_SOURCE_INVALID', path + '.build.template', 'build template must be a committed plans/<slug>.plan.txt file')
  assertCorpus(Number.isSafeInteger(build.repeat) && build.repeat >= 1 && build.repeat <= 100000, 'BUILD_SPEC_INVALID', path + '.build.repeat', 'repeat must be a positive integer')
  assertCorpus(build.lineEnding === 'lf' || build.lineEnding === 'crlf', 'BUILD_SPEC_INVALID', path + '.build.lineEnding', 'lineEnding must be lf or crlf')
  if (Object.hasOwn(build, 'longLine')) {
    assertCorpus(Number.isSafeInteger(build.longLine) && build.longLine >= 1 && build.longLine <= 100000, 'BUILD_SPEC_INVALID', path + '.build.longLine', 'longLine must be a positive character count')
  }
}

function checkRepoSpec(repo, path) {
  assertPlain(repo, path, 'repo')
  const keys = Object.keys(repo)
  assertCorpus(keys.length >= 1, 'FIXTURE_FILE_INVALID', path, 'each case materializes at least one local source file')
  for (const relative of keys) {
    const entryPath = path + '[' + JSON.stringify(relative) + ']'
    assertCorpus(isSafeRelative(relative), 'UNSAFE_PATH', entryPath, 'fixture path ' + JSON.stringify(relative) + ' must be repository-relative')
    assertCorpus(!relative.startsWith('.dsh/'), 'FIXTURE_FILE_INVALID', entryPath, 'fixture repo may not write under .dsh/; the plan target is owned by the corpus')
    const entry = assertPlain(repo[relative], entryPath, 'fixture file')
    assertKnownKeys(entry, ['text', 'source'], entryPath, 'fixture file')
    const hasText = Object.hasOwn(entry, 'text')
    const hasSource = Object.hasOwn(entry, 'source')
    assertCorpus(hasText !== hasSource, 'FIXTURE_FILE_INVALID', entryPath, 'exactly one of text/source is required')
    if (hasText) assertCorpus(typeof entry.text === 'string' && entry.text !== '', 'FIXTURE_FILE_INVALID', entryPath + '.text', 'inline fixture text must be a non-empty string')
    else assertCorpus(typeof entry.source === 'string' && SOURCE_RE.test(entry.source), 'FIXTURE_FILE_INVALID', entryPath + '.source', 'materialized sources must be committed sources/*.txt files')
  }
}

function checkExpectedShape(spec, path) {
  const expected = assertPlain(spec.expected, path + '.expected', 'expected')
  assertKnownKeys(expected, EXPECTED_KEYS, path + '.expected', 'expected')
  assertCorpus(typeof expected.planSha256 === 'string' && SHA_RE.test(expected.planSha256), 'PLAN_SHA_INVALID', path + '.expected.planSha256', 'planSha256 must be the raw SHA-256 of the built bytes')
  const lint = assertPlain(expected.lint, path + '.expected.lint', 'lint expectation')
  assertKnownKeys(lint, LINT_KEYS, path + '.expected.lint', 'lint expectation')
  assertCorpus(typeof lint.valid === 'boolean', 'LINT_EXPECTATION_INVALID', path + '.expected.lint.valid', 'lint.valid must be a boolean')
  assertCorpus(Array.isArray(lint.errors), 'LINT_EXPECTATION_INVALID', path + '.expected.lint.errors', 'lint.errors must be an array')
  assertCorpus(Array.isArray(lint.warnings), 'LINT_EXPECTATION_INVALID', path + '.expected.lint.warnings', 'lint.warnings must be an array')
  assertCorpus(lint.valid === (lint.errors.length === 0), 'LINT_VALID_CONTRADICTION', path + '.expected.lint', 'lint.valid must equal "no expected error diagnostics"')
  lint.errors.forEach((entry, index) => {
    const entryPath = path + '.expected.lint.errors[' + index + ']'
    assertPlain(entry, entryPath, 'expected lint error')
    assertKnownKeys(entry, ERROR_KEYS, entryPath, 'expected lint error')
    assertCorpus(ERROR_CODES.includes(entry.code), 'UNKNOWN_EXPECTED_CODE', entryPath + '.code', 'unknown expected error code ' + JSON.stringify(entry.code))
    assertCorpus(Number.isSafeInteger(entry.line) && entry.line >= 0, 'LINT_EXPECTATION_INVALID', entryPath + '.line', 'expected error line must be a non-negative integer')
    assertCorpus(typeof entry.taskId === 'string', 'LINT_EXPECTATION_INVALID', entryPath + '.taskId', 'expected error taskId must be a string')
  })
  lint.warnings.forEach((entry, index) => {
    const entryPath = path + '.expected.lint.warnings[' + index + ']'
    assertPlain(entry, entryPath, 'expected lint warning')
    assertKnownKeys(entry, WARNING_KEYS, entryPath, 'expected lint warning')
    assertCorpus(WARNING_CODES.includes(entry.code), 'UNKNOWN_EXPECTED_CODE', entryPath + '.code', 'unknown expected warning code ' + JSON.stringify(entry.code))
  })
  assertCorpus(Array.isArray(expected.blockers), 'BLOCKER_INVALID', path + '.expected.blockers', 'expected.blockers must be an array')
  const ids = new Set()
  expected.blockers.forEach((blocker, index) => {
    const blockerPath = path + '.expected.blockers[' + index + ']'
    assertPlain(blocker, blockerPath, 'expected blocker')
    assertKnownKeys(blocker, BLOCKER_KEYS, blockerPath, 'expected blocker')
    assertCorpus(typeof blocker.id === 'string' && PROTOCOL_ID_RE.test(blocker.id), 'STABLE_ID_MISMATCH', blockerPath + '.id', 'blocker id ' + JSON.stringify(blocker.id) + ' is not a protocol identifier')
    assertCorpus(LANES.includes(blocker.lane), 'UNKNOWN_LANE', blockerPath + '.lane', 'blocker lane must be practical or adversarial')
    assertCorpus(BLOCKER_ELIGIBILITIES.includes(blocker.eligibility), 'UNKNOWN_ELIGIBILITY', blockerPath + '.eligibility', 'unknown blocker eligibility ' + JSON.stringify(blocker.eligibility))
    const location = assertPlain(blocker.location, blockerPath + '.location', 'blocker location')
    assertKnownKeys(location, LOCATION_KEYS, blockerPath + '.location', 'blocker location')
    for (const key of LOCATION_KEYS) assertCorpus(typeof location[key] === 'string', 'ANCHOR_INVALID', blockerPath + '.location.' + key, 'location.' + key + ' must be a string (empty when not applicable)')
    const anchor = anchorOf(blocker)
    assertCorpus(anchor !== null, 'ANCHOR_INVALID', blockerPath + '.location', 'exactly one of taskId/isId/gapId must anchor the blocker')
    const pattern = anchor.key === 'taskId' ? /^(?:[1-9][0-9]*|F[1-9][0-9]*)$/ : anchor.key === 'isId' ? /^IS-[1-9][0-9]*$/ : /^GAP-[1-9][0-9]*$/
    assertCorpus(pattern.test(anchor.value), 'ANCHOR_INVALID', blockerPath + '.location.' + anchor.key, 'invalid plan anchor ' + JSON.stringify(anchor.value))
    const derived = stableBlockerId(blocker)
    assertCorpus(blocker.id === derived, 'STABLE_ID_MISMATCH', blockerPath + '.id', 'blocker id must be the stable derivation ' + JSON.stringify(derived) + ', not ' + JSON.stringify(blocker.id))
    assertCorpus(!ids.has(blocker.id), 'DUPLICATE_BLOCKER_ID', blockerPath + '.id', 'duplicate blocker id inside one case')
    ids.add(blocker.id)
    assertCorpus(typeof blocker.remediation === 'string' && blocker.remediation.trim() !== '', 'BLOCKER_INVALID', blockerPath + '.remediation', 'blocker needs concrete remediation text')
    assertCorpus(Array.isArray(blocker.evidence), 'EVIDENCE_MISSING', blockerPath + '.evidence', 'evidence must be an array')
    assertCorpus(blocker.evidence.length >= 1, 'EVIDENCE_MISSING', blockerPath + '.evidence', 'an expected blocker needs at least one evidence entry; truth evidence may not be deleted')
    blocker.evidence.forEach((entry, evidenceIndex) => {
      const entryPath = blockerPath + '.evidence[' + evidenceIndex + ']'
      assertPlain(entry, entryPath, 'evidence entry')
      assertKnownKeys(entry, EVIDENCE_KEYS, entryPath, 'evidence entry')
      assertCorpus(isSafeRelative(entry.path), 'UNSAFE_PATH', entryPath + '.path', 'evidence path must stay inside the fixture repo')
      const target = planTargetOf(spec)
      assertCorpus(entry.path === target || Object.hasOwn(spec.repo, entry.path), 'EVIDENCE_UNKNOWN_PATH', entryPath + '.path', 'evidence path ' + JSON.stringify(entry.path) + ' is neither the plan target nor a declared fixture source')
      assertCorpus(Number.isSafeInteger(entry.line) && entry.line >= 1, 'EVIDENCE_SHAPE', entryPath + '.line', 'evidence line must be a positive integer')
      assertCorpus(Number.isSafeInteger(entry.endLine) && entry.endLine >= entry.line, 'EVIDENCE_SHAPE', entryPath + '.endLine', 'evidence endLine must be >= line')
      assertCorpus(typeof entry.marker === 'string' && entry.marker.trim() !== '' && entry.marker.length <= 200 && !CONTROL_RE.test(entry.marker), 'EVIDENCE_SHAPE', entryPath + '.marker', 'evidence marker must be short nonempty text that occurs on the cited lines')
    })
  })
  assertCorpus(Array.isArray(expected.nonBlockingNotes) && expected.nonBlockingNotes.length >= 1, 'NOTES_MISSING', path + '.expected.nonBlockingNotes', 'every case must name at least one finding that must not block')
  expected.nonBlockingNotes.forEach((note, index) => {
    assertCorpus(typeof note === 'string' && note.trim() !== '' && note.length <= 600 && !CONTROL_RE.test(note), 'NOTES_INVALID', path + '.expected.nonBlockingNotes[' + index + ']', 'notes must be short plain text; they are never blockers')
  })
}

function checkManifestShape(manifest) {
  assertPlain(manifest, '$', 'manifest')
  assertCorpus(manifest.version === 1, 'CORPUS_SHAPE', '$.version', 'manifest version must be 1')
  assertCorpus(manifest.corpus === CORPUS_NAME, 'CORPUS_SHAPE', '$.corpus', 'unexpected corpus name')
  const conventions = assertPlain(manifest.conventions, '$.conventions', 'conventions')
  assertKnownKeys(conventions, CONVENTION_KEYS, '$.conventions', 'conventions')
  for (const key of CONVENTION_KEYS) {
    assertCorpus(typeof conventions[key] === 'string' && conventions[key].trim() !== '', 'CONVENTION_MISSING', '$.conventions.' + key, 'corpus convention ' + key + ' is required so consumers share one rule')
  }
  assertCorpus(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'CORPUS_SHAPE', '$.cases', 'cases must be a non-empty array')
  assertCorpus(Number.isSafeInteger(manifest.seedCases) && manifest.seedCases === manifest.cases.length, 'SEED_COUNT_MISMATCH', '$.seedCases', 'seedCases must equal the number of cases (' + manifest.cases.length + ') so a seed can never be silently skipped')
  const caseIds = new Set()
  const slugs = new Set()
  const defects = []
  let clean = 0
  let bad = 0
  manifest.cases.forEach((spec, index) => {
    const at = 'cases[' + index + ']'
    assertPlain(spec, at, 'case')
    assertKnownKeys(spec, CASE_KEYS, at, 'case')
    assertCorpus(typeof spec.caseId === 'string' && CASE_ID_RE.test(spec.caseId), 'CASE_ID_INVALID', at + '.caseId', 'caseId must match ' + CASE_ID_RE)
    assertCorpus(!caseIds.has(spec.caseId), 'DUPLICATE_CASE_ID', at + '.caseId', 'duplicate caseId ' + JSON.stringify(spec.caseId) + '; every seed case must be addressable exactly once')
    caseIds.add(spec.caseId)
    assertCorpus(spec.classification === 'clean' || spec.classification === 'bad', 'CORPUS_SHAPE', at + '.classification', 'classification must be clean or bad')
    if (spec.classification === 'clean') {
      clean += 1
      assertCorpus(spec.defect === null, 'CLEAN_DEFECT', at + '.defect', 'clean case ' + spec.caseId + ' must declare no defect')
    } else {
      bad += 1
      assertCorpus(typeof spec.defect === 'string' && REQUIRED_DEFECTS.includes(spec.defect), 'UNKNOWN_DEFECT', at + '.defect', 'bad case ' + spec.caseId + ' declares unknown defect ' + JSON.stringify(spec.defect))
      assertCorpus(!defects.includes(spec.defect), 'DUPLICATE_DEFECT', at + '.defect', 'defect ' + spec.defect + ' is already covered by another case')
      defects.push(spec.defect)
    }
    assertCorpus(typeof spec.summary === 'string' && spec.summary.trim() !== '', 'CORPUS_SHAPE', at + '.summary', 'summary is required')
    assertCorpus(typeof spec.structural === 'boolean', 'CORPUS_SHAPE', at + '.structural', 'structural must state whether lint enforces the truth')
    checkPlanSpec(spec.plan, at + '.plan')
    assertCorpus(!slugs.has(spec.plan.slug), 'DUPLICATE_SLUG', at + '.plan.slug', 'duplicate plan target ' + spec.plan.slug)
    slugs.add(spec.plan.slug)
    checkRepoSpec(spec.repo, at + '.repo')
    checkExpectedShape(spec, at)
    const lint = spec.expected.lint
    assertCorpus(spec.structural === !lint.valid, 'STRUCTURAL_MISMATCH', at + '.structural', 'structural must equal "lint rejects this fixture" so the grouping can never drift')
    if (spec.classification === 'clean') {
      assertCorpus(lint.valid === true && lint.errors.length === 0, 'CLEAN_REJECTED_BY_LINT', at + '.expected.lint', 'clean case ' + spec.caseId + ' must not be rejected by lint')
      assertCorpus(spec.expected.blockers.length === 0, 'CLEAN_BLOCKER', at + '.expected.blockers', 'clean case ' + spec.caseId + ' must carry no expected blocker')
    } else {
      assertCorpus(spec.expected.blockers.length >= 1 && spec.expected.blockers.length <= 3, 'BAD_BLOCKER_COUNT', at + '.expected.blockers', 'bad case ' + spec.caseId + ' needs 1..3 expected blockers')
    }
  })
  assertCorpus(clean >= 4, 'CLEAN_COUNT', '$.cases', 'at least four clean cases are required, found ' + clean)
  assertCorpus(bad >= 8, 'BAD_COUNT', '$.cases', 'at least eight bad cases are required, found ' + bad)
  for (const defect of REQUIRED_DEFECTS) assertCorpus(defects.includes(defect), 'DEFECT_MISSING', '$.cases', 'required bad defect ' + defect + ' has no case')
  return manifest
}

function fillerLine(index) {
  return '- 第 ' + index + ' 段：确定性 UTF-8 填充行，包含中文、emoji 🧭🔬、全角标点（，。）；不含时间戳、随机值与网络地址。'
}

function longFillerLine(charCount) {
  return '　计划长行：' + '长'.repeat(charCount) + '（结束）。'
}

function buildPlanText(template, build) {
  let text = template.replace(/\r\n/g, '\n')
  if (build.repeat !== undefined) {
    assertCorpus(text.split(REPEAT_TOKEN).length === 2, 'BUILD_TOKEN_UNRESOLVED', build.template, 'build template must contain exactly one ' + REPEAT_TOKEN + ' marker line')
    const filler = []
    for (let index = 1; index <= build.repeat; index += 1) filler.push(fillerLine(index))
    text = text.replace(REPEAT_TOKEN, filler.join('\n'))
  }
  if (build.longLine !== undefined) {
    assertCorpus(text.split(LONG_TOKEN).length === 2, 'BUILD_TOKEN_UNRESOLVED', build.template, 'build template must contain exactly one ' + LONG_TOKEN + ' marker line')
    text = text.replace(LONG_TOKEN, longFillerLine(build.longLine))
  }
  assertCorpus(!text.includes(REPEAT_TOKEN) && !text.includes(LONG_TOKEN), 'BUILD_TOKEN_UNRESOLVED', build.template, 'build markers must all resolve')
  if (build.lineEnding === 'crlf') text = text.replace(/\n/g, '\r\n')
  return text
}

async function writeFixtureFile(path, text) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, text, 'utf8')
}

async function materializeCase(spec, root) {
  const planText = Object.hasOwn(spec.plan, 'source')
    ? await readCorpusText(spec.plan.source)
    : buildPlanText(await readCorpusText(spec.plan.build.template), spec.plan.build)
  const target = planTargetOf(spec)
  await writeFixtureFile(join(root, target), planText)
  for (const relative of Object.keys(spec.repo)) {
    const entry = spec.repo[relative]
    const content = Object.hasOwn(entry, 'text') ? entry.text : await readCorpusText(entry.source)
    await writeFixtureFile(join(root, relative), content)
  }
  return { root, target, planText, planPath: join(root, target) }
}

async function listFiles(root, current = '') {
  const entries = await fs.readdir(current === '' ? root : join(root, current), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = current === '' ? entry.name : current + '/' + entry.name
    if (entry.isDirectory()) files.push(...await listFiles(root, relative))
    else if (entry.isFile()) files.push(relative)
    else files.push(relative + ' (non-regular)')
  }
  return files.sort()
}

function compareJson(left, right) {
  const a = JSON.stringify(left)
  const b = JSON.stringify(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function errorTuples(result) {
  return result.diagnostics
    .filter(diagnostic => diagnostic.severity === 'error')
    .map(diagnostic => ({ code: diagnostic.code, line: diagnostic.line, taskId: diagnostic.taskId }))
    .sort(compareJson)
}

function warningTuples(result) {
  return result.diagnostics
    .filter(diagnostic => diagnostic.severity === 'warning')
    .map(diagnostic => ({ code: diagnostic.code }))
    .sort(compareJson)
}

function expectedErrorTuples(expected) {
  return expected.errors.map(entry => ({ code: entry.code, line: entry.line, taskId: entry.taskId })).sort(compareJson)
}

function expectedWarningTuples(expected) {
  return expected.warnings.map(entry => ({ code: entry.code })).sort(compareJson)
}

function assertTuples(actual, expected, code, path, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(code, path, label + ' differ; actual ' + JSON.stringify(actual) + ' but truth expects ' + JSON.stringify(expected))
  }
}

function collectTableIds(planText, prefix) {
  const ids = new Set()
  for (const line of planText.split('\n')) {
    const match = new RegExp('^\\|\\s*(' + prefix + '-[0-9]+)\\s*\\|').exec(line)
    if (match !== null) ids.add(match[1])
  }
  return ids
}

async function checkCaseAgainstFixture(spec, repo) {
  const expected = spec.expected
  const planSha = sha256(repo.planText)
  assertCorpus(planSha === expected.planSha256, 'PLAN_SHA_MISMATCH', spec.caseId + '.expected.planSha256', 'fixture bytes hash to ' + planSha + ' but the truth manifest pins ' + expected.planSha256 + '; the truth is stale')
  assertCorpus(repo.target === planTargetOf(spec), 'TARGET_MISMATCH', spec.caseId, 'materialized plan is not at the declared target ' + planTargetOf(spec))
  const lint = lintPlan({ content: repo.planText, path: repo.target, workspace: repo.root })
  assertCorpus(lint.sha256 === planSha, 'LINT_SHA_MISMATCH', spec.caseId, 'lintPlan hashed different bytes than materialized')
  assertTuples(errorTuples(lint), expectedErrorTuples(expected.lint), 'LINT_ERROR_MISMATCH', spec.caseId + '.expected.lint.errors', 'lint error diagnostics')
  assertTuples(warningTuples(lint), expectedWarningTuples(expected.lint), 'LINT_WARNING_MISMATCH', spec.caseId + '.expected.lint.warnings', 'lint warning diagnostics')
  assertCorpus(lint.valid === expected.lint.valid, 'LINT_VALID_MISMATCH', spec.caseId + '.expected.lint.valid', 'lint valid=' + lint.valid + ' but truth expects ' + expected.lint.valid)

  const cli = spawnSync(process.execPath, [CLI, repo.target, '--json'], { cwd: repo.root, encoding: 'utf8' })
  const expectedExit = lint.valid ? 0 : 2
  assertCorpus(cli.status === expectedExit, 'CLI_EXIT_MISMATCH', spec.caseId, 'plan-lint exited ' + cli.status + ' (expected ' + expectedExit + '); stderr=' + JSON.stringify(cli.stderr))
  let cliResult
  try {
    cliResult = JSON.parse(cli.stdout)
  } catch (error) {
    fail('CLI_OUTPUT_INVALID', spec.caseId, 'plan-lint --json did not return JSON: ' + error.message)
  }
  assertCorpus(cliResult.sha256 === planSha && cliResult.valid === expected.lint.valid, 'CLI_RESULT_MISMATCH', spec.caseId, 'plan-lint result does not match lintPlan')
  assertTuples(errorTuples(cliResult), expectedErrorTuples(expected.lint), 'CLI_DIAGNOSTIC_MISMATCH', spec.caseId, 'plan-lint error diagnostics')

  for (const lane of LANES) {
    const raw = laneResult(spec, lane, planSha)
    const checked = validateReviewResult(raw, { lane, roundId: raw.roundId, launchId: raw.launchId, planSha256: planSha })
    assertCorpus(checked.ok, 'TRUTH_BLOCKER_INVALID', spec.caseId + '.' + lane, 'expected blocker is not a protocol-valid result: ' + JSON.stringify(checked.diagnostics))
    assertCorpus(checked.value.blockers.length === raw.blockers.length, 'TRUTH_BLOCKER_DEMOTED', spec.caseId + '.' + lane, 'an expected blocker lost eligibility or evidence and became a note')
    assertCorpus(checked.value.notes.length === expected.nonBlockingNotes.length, 'TRUTH_NOTE_DROPPED', spec.caseId + '.' + lane, 'expected non-blocking notes did not survive protocol validation')
    assertCorpus(checked.value.verdict === raw.verdict, 'TRUTH_VERDICT_MISMATCH', spec.caseId + '.' + lane, 'protocol changed the expected verdict')
  }

  const parsed = parsePlanDocument(repo.planText)
  const taskIds = new Set(parsed.tasks.map(task => task.id))
  const isIds = collectTableIds(repo.planText, 'IS')
  const gapIds = collectTableIds(repo.planText, 'GAP')
  const lineCache = new Map()
  const linesOf = async relative => {
    if (!lineCache.has(relative)) {
      let text
      try {
        text = await fs.readFile(join(repo.root, relative), 'utf8')
      } catch (error) {
        fail('EVIDENCE_UNREACHABLE', spec.caseId + '.' + relative, 'truth evidence does not resolve inside the fixture repo: ' + error.message)
      }
      lineCache.set(relative, text.split('\n'))
    }
    return lineCache.get(relative)
  }
  for (const blocker of expected.blockers) {
    const anchor = anchorOf(blocker)
    if (anchor.key === 'taskId') assertCorpus(taskIds.has(anchor.value), 'ANCHOR_UNKNOWN', spec.caseId + '.expected.blockers.' + blocker.id, 'taskId ' + anchor.value + ' is not a task in the fixture plan')
    if (anchor.key === 'isId') assertCorpus(isIds.has(anchor.value), 'ANCHOR_UNKNOWN', spec.caseId + '.expected.blockers.' + blocker.id, 'isId ' + anchor.value + ' is not declared in the fixture plan')
    if (anchor.key === 'gapId') assertCorpus(gapIds.has(anchor.value), 'ANCHOR_UNKNOWN', spec.caseId + '.expected.blockers.' + blocker.id, 'gapId ' + anchor.value + ' is not declared in the fixture plan')
    for (const entry of blocker.evidence) {
      const lines = await linesOf(entry.path)
      assertCorpus(entry.line <= lines.length && entry.endLine <= lines.length, 'EVIDENCE_LINE_OUT_OF_RANGE', spec.caseId + '.expected.blockers.' + blocker.id, 'evidence ' + entry.path + ':' + entry.line + '-' + entry.endLine + ' is outside the fixture file (' + lines.length + ' lines)')
      const window = lines.slice(entry.line - 1, entry.endLine)
      assertCorpus(window.some(text => text.includes(entry.marker)), 'EVIDENCE_MARKER_MISSING', spec.caseId + '.expected.blockers.' + blocker.id, 'marker ' + JSON.stringify(entry.marker) + ' does not occur on ' + entry.path + ':' + entry.line + '-' + entry.endLine)
    }
  }

  if (spec.structural) {
    assertCorpus(expected.lint.errors.length > 0, 'STRUCTURAL_MISMATCH', spec.caseId, 'a structural case must pin at least one lint error')
    for (const entry of expected.lint.errors) {
      if (entry.taskId === '') continue
      assertCorpus(expected.blockers.some(blocker => blocker.location.taskId === entry.taskId), 'STRUCTURAL_ANCHOR_MISSING', spec.caseId, 'structural error ' + entry.code + ' on task ' + entry.taskId + ' has no expected blocker anchored to it')
    }
  } else {
    assertCorpus(expected.lint.errors.length === 0, 'SEMANTIC_NOT_STRUCTURAL', spec.caseId, 'a semantic case may not carry a structural lint error; the defect must stay reviewer-only')
  }
  return { lint, parsed }
}

function expectCorpusError(run, code, pathPart) {
  let caught
  try {
    run()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof CorpusError, 'expected CorpusError ' + code + ', got ' + (caught === undefined ? 'no error' : String(caught && caught.stack)))
  assert.equal(caught.code, code)
  if (pathPart !== undefined) assert.ok(caught.path.includes(pathPart), 'expected error path to mention ' + pathPart + ', got ' + caught.path + ' (' + caught.message + ')')
  return caught
}

async function expectCorpusErrorAsync(run, code, pathPart) {
  let caught
  try {
    await run()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof CorpusError, 'expected CorpusError ' + code + ', got ' + (caught === undefined ? 'no error' : String(caught && caught.stack)))
  assert.equal(caught.code, code)
  if (pathPart !== undefined) assert.ok(caught.path.includes(pathPart), 'expected error path to mention ' + pathPart + ', got ' + caught.path + ' (' + caught.message + ')')
  return caught
}

const manifest = checkManifestShape(await loadManifest())
const executed = new Set()
const cleanup = []

test('manifest is a complete, self-describing seed corpus', () => {
  const clean = manifest.cases.filter(spec => spec.classification === 'clean')
  const bad = manifest.cases.filter(spec => spec.classification === 'bad')
  assert.ok(clean.length >= 4, 'clean cases: ' + clean.length)
  assert.ok(bad.length >= 8, 'bad cases: ' + bad.length)
  assert.equal(manifest.seedCases, manifest.cases.length)
  assert.equal(new Set(manifest.cases.map(spec => spec.caseId)).size, manifest.cases.length)
  for (const defect of REQUIRED_DEFECTS) assert.ok(bad.some(spec => spec.defect === defect), 'missing defect ' + defect)
  for (const caseId of ['clean-new-file', 'clean-fenced', 'clean-large-utf8', 'clean-small-change']) {
    assert.ok(clean.some(spec => spec.caseId === caseId), 'missing clean case ' + caseId)
  }
  for (const spec of manifest.cases) {
    assert.equal(spec.structural, spec.expected.lint.valid === false, spec.caseId)
    assert.ok(spec.expected.nonBlockingNotes.length >= 1, spec.caseId)
  }
})

test('lint grouping keeps structural faults and reviewer-only truth separate', () => {
  for (const spec of manifest.cases) {
    const errors = spec.expected.lint.errors
    const warnings = spec.expected.lint.warnings
    assert.equal(spec.structural, errors.length > 0, spec.caseId + ': structural must mean the lint rejects the bytes')
    for (const entry of errors) assert.ok(ERROR_CODES.includes(entry.code), spec.caseId + ' error ' + entry.code)
    for (const entry of warnings) assert.ok(WARNING_CODES.includes(entry.code), spec.caseId + ' warning ' + entry.code)
    if (spec.classification === 'clean') {
      assert.equal(errors.length, 0, spec.caseId)
      assert.equal(spec.expected.blockers.length, 0, spec.caseId)
      continue
    }
    if (spec.structural) {
      assert.ok(errors.length > 0, spec.caseId)
      for (const entry of errors) {
        if (entry.taskId === '') continue
        assert.ok(spec.expected.blockers.some(blocker => blocker.location.taskId === entry.taskId), spec.caseId + ': lint error without an anchored blocker')
      }
      continue
    }
    assert.equal(errors.length, 0, spec.caseId + ': a reviewer-only defect may not appear as a lint error')
    assert.ok(spec.expected.blockers.length > 0, spec.caseId)
    for (const warning of warnings) {
      assert.ok(!spec.expected.blockers.some(blocker => blocker.id === warning.code), spec.caseId + ': a warning became a blocker id')
    }
  }
})

test('fixture sources cannot be executed by the default test scanner', async () => {
  const files = await listFiles(CORPUS_DIR)
  assert.ok(files.includes('manifest.json'))
  for (const relative of files) {
    assert.ok(relative.endsWith('.json') || relative.endsWith('.txt'), 'unexpected executable fixture file ' + relative)
  }
})

for (const spec of manifest.cases) {
  test('seed case ' + spec.caseId + ' (' + spec.classification + '/' + (spec.defect === null ? 'clean' : spec.defect) + ')', async () => {
    executed.add(spec.caseId)
    const root = await fs.mkdtemp(join(tmpdir(), 'ulw-review-corpus-' + spec.caseId + '-'))
    try {
      const repo = await materializeCase(spec, root)
      await checkCaseAgainstFixture(spec, repo)
      const planned = [repo.target, ...Object.keys(spec.repo)].sort()
      assertTuples(await listFiles(root), planned, 'FIXTURE_LEAK', spec.caseId, 'materialized fixture files')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      cleanup.push({ root, removed: !existsSync(root) })
    }
  })
}

test('every seed case ran exactly once and left no temporary worktree', () => {
  assert.equal(executed.size, manifest.seedCases)
  assert.deepEqual([...executed].sort(), manifest.cases.map(spec => spec.caseId).sort())
  assert.equal(cleanup.length, manifest.seedCases)
  for (const entry of cleanup) assert.equal(entry.removed, true, 'temporary fixture repo was not removed: ' + entry.root)
})

test('truth tampering fails precisely and can never silently skip a seed', async t => {
  const base = await loadManifest()
  const clone = () => structuredClone(base)

  await t.test('duplicate caseId is refused, not last-writer-wins', () => {
    const copy = clone()
    copy.cases[1].caseId = copy.cases[0].caseId
    expectCorpusError(() => checkManifestShape(copy), 'DUPLICATE_CASE_ID', 'cases[1].caseId')
  })

  await t.test('deleted truth evidence entry is refused', () => {
    const copy = clone()
    const index = copy.cases.findIndex(spec => spec.classification === 'bad' && spec.expected.blockers.length > 0)
    copy.cases[index].expected.blockers[0].evidence = []
    expectCorpusError(() => checkManifestShape(copy), 'EVIDENCE_MISSING', 'evidence')
  })

  await t.test('unknown expected code is refused', () => {
    const copy = clone()
    const spec = copy.cases.find(entry => entry.expected.lint.warnings.length === 0)
    spec.expected.lint.warnings.push({ code: 'WARNING_THAT_DOES_NOT_EXIST' })
    expectCorpusError(() => checkManifestShape(copy), 'UNKNOWN_EXPECTED_CODE', 'warnings[0].code')
  })

  await t.test('blocker id that is not the stable derivation is refused', () => {
    const copy = clone()
    const spec = copy.cases.find(entry => entry.classification === 'bad')
    spec.expected.blockers[0].id = 'blk.practical.missing_reference.999'
    expectCorpusError(() => checkManifestShape(copy), 'STABLE_ID_MISMATCH', '.expected.blockers[0].id')
  })

  await t.test('expectation unreachable from its fixture is refused', async () => {
    const copy = clone()
    const spec = copy.cases.find(entry => entry.caseId === 'bad-missing-reference')
    spec.expected.blockers[0].evidence[0].line = 100000
    spec.expected.blockers[0].evidence[0].endLine = 100000
    const root = await fs.mkdtemp(join(tmpdir(), 'ulw-review-tamper-'))
    try {
      const repo = await materializeCase(spec, root)
      await expectCorpusErrorAsync(() => checkCaseAgainstFixture(spec, repo), 'EVIDENCE_LINE_OUT_OF_RANGE', '.expected.blockers.')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  await t.test('evidence marker that no longer exists is refused', async () => {
    const copy = clone()
    const spec = copy.cases.find(entry => entry.caseId === 'bad-missing-reference')
    spec.expected.blockers[0].evidence[0].marker = 'marker-that-is-not-in-the-fixture'
    const root = await fs.mkdtemp(join(tmpdir(), 'ulw-review-tamper-'))
    try {
      const repo = await materializeCase(spec, root)
      await expectCorpusErrorAsync(() => checkCaseAgainstFixture(spec, repo), 'EVIDENCE_MARKER_MISSING', '.expected.blockers.')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  await t.test('truth hash computed for stale bytes is refused', async () => {
    const copy = clone()
    const spec = copy.cases.find(entry => entry.classification === 'bad')
    spec.expected.planSha256 = 'f'.repeat(64)
    const root = await fs.mkdtemp(join(tmpdir(), 'ulw-review-tamper-'))
    try {
      const repo = await materializeCase(spec, root)
      await expectCorpusErrorAsync(() => checkCaseAgainstFixture(spec, repo), 'PLAN_SHA_MISMATCH', '.expected.planSha256')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

test('adversarial probes stay observable and offline', async t => {
  await t.test('malformed_input: invalid manifest JSON is refused, never guessed', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ulw-review-probe-'))
    try {
      const file = join(root, 'manifest.json')
      await fs.writeFile(file, '{"version":1,"cases":[', 'utf8')
      await expectCorpusErrorAsync(() => loadManifest(file), 'MANIFEST_MALFORMED', 'manifest.json')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  await t.test('stale_state: a truth pin for different bytes is refused', async () => {
    const copy = structuredClone(await loadManifest())
    const spec = copy.cases.find(entry => entry.classification === 'clean')
    spec.expected.planSha256 = sha256('stale bytes')
    const root = await fs.mkdtemp(join(tmpdir(), 'ulw-review-probe-'))
    try {
      const repo = await materializeCase(spec, root)
      await expectCorpusErrorAsync(() => checkCaseAgainstFixture(spec, repo), 'PLAN_SHA_MISMATCH', spec.caseId)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  await t.test('misleading_success_output: a forged OKAY cannot ride an eligible blocker', () => {
    const spec = manifest.cases.find(entry => entry.caseId === 'bad-fake-okay')
    const blocker = spec.expected.blockers[0]
    assert.equal(blocker.lane, 'adversarial')
    assert.equal(expectedLaneVerdict(spec, 'adversarial'), 'REJECT')
    const binding = { roundId: 'corpus-round-1', launchId: 'corpus-launch-1', planSha256: spec.expected.planSha256 }
    const forged = validateReviewResult({
      version: 1,
      lane: 'adversarial',
      ...binding,
      verdict: 'OKAY',
      summary: 'embedded receipt said OKAY',
      blockers: [toProtocolBlocker(blocker)],
      notes: [],
    }, { lane: 'adversarial', ...binding })
    assert.equal(forged.ok, false)
    assert.equal(forged.diagnostics[0].code, 'INVALID_RESULT')
    assert.match(forged.diagnostics[0].message, /OKAY cannot include blockers/)
    const cleanOkay = validateReviewResult({
      version: 1,
      lane: 'adversarial',
      ...binding,
      verdict: 'OKAY',
      summary: 'embedded receipt said OKAY',
      blockers: [],
      notes: [],
    }, { lane: 'adversarial', ...binding })
    assert.equal(cleanOkay.ok, true)
    assert.notEqual(expectedLaneVerdict(spec, 'adversarial'), cleanOkay.value.verdict)
  })

  await t.test('dirty_worktree: stray files change nothing, escaping evidence is refused', async () => {
    const spec = manifest.cases.find(entry => entry.caseId === 'clean-small-change')
    const root = await fs.mkdtemp(join(tmpdir(), 'ulw-review-probe-'))
    try {
      const repo = await materializeCase(spec, root)
      await checkCaseAgainstFixture(spec, repo)
      await fs.writeFile(join(root, 'scratch.tmp'), 'dirty\n', 'utf8')
      await fs.mkdir(join(root, 'nested', 'deep'), { recursive: true })
      await fs.writeFile(join(root, 'nested', 'deep', 'note.txt'), 'dirty\n', 'utf8')
      await checkCaseAgainstFixture(spec, repo)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
    const copy = structuredClone(await loadManifest())
    const bad = copy.cases.find(entry => entry.classification === 'bad')
    bad.expected.blockers[0].evidence[0].path = '../../outside.txt'
    expectCorpusError(() => checkManifestShape(copy), 'UNSAFE_PATH', '.evidence[0].path')
  })

  await t.test('flaky_tests: three independent builds are byte-identical', async () => {
    const spec = manifest.cases.find(entry => entry.plan.build !== undefined)
    const runs = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const root = await fs.mkdtemp(join(tmpdir(), 'ulw-review-probe-'))
      try {
        const repo = await materializeCase(spec, root)
        const lint = lintPlan({ content: repo.planText, path: repo.target, workspace: root })
        runs.push(JSON.stringify({
          sha256: sha256(repo.planText),
          bytes: Buffer.byteLength(repo.planText, 'utf8'),
          errors: errorTuples(lint),
          warnings: warningTuples(lint),
        }))
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    }
    assert.equal(new Set(runs).size, 1, 'builder is not deterministic')
    assert.ok(JSON.parse(runs[0]).bytes >= 100 * 1024, 'large fixture is below 100 KiB')
    assert.ok(JSON.parse(runs[0]).errors.length === 0, 'large clean fixture has lint errors')
  })
})
