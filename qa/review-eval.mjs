#!/usr/bin/env node
/**
 * Review quality evaluation runner with two deliberately separated modes.
 *
 * replay (default): fully offline and deterministic. It materializes every fixture
 * from the row-6 truth manifest into a private scratch workspace, runs the real
 * lintPlan structural check, replays the manifest's recorded lane truth through the
 * real validateReviewResult protocol, and computes TP/FP/FN, clean-case false
 * rejects, two-lane disagreement, calls and usage. It validates the EVALUATOR only:
 * live_quality is always the literal "not_measured" because no model was called.
 *
 * live: never reachable by accident. It requires an explicit --authorize-live or
 * --confirm-live flag, an operator budget file, a configured key named by that
 * file's keyEnv, and a budget that explicitly accepts a paid quota. If any of those
 * is missing it exits nonzero with LIVE_AUTH_REQUIRED before constructing a
 * transport, reading a manifest, creating a workspace or attempting any network
 * call. Authorized live runs are bounded per lane, mask secrets in their report,
 * classify a sentinel leaked into a workspace as lab_error, keep partial data when
 * a run is cancelled or a budget stops it, and always remove their scratch roots.
 *
 * This module has no production dependency outside Node builtins and the plugin's
 * own pure review modules. It never reads personal credentials files: the only key
 * input is the environment variable named by the operator budget file.
 *
 * Usage:
 *   node qa/review-eval.mjs --mode replay --out "$E/eval"
 *   node qa/review-eval.mjs --mode live --authorize-live --authorization budget.json --out "$E/live"
 *
 * Exit codes: 0 pass; 2 replay failure; 4 live authorization required/invalid;
 * 5 live cancelled; 6 live lab_error; 7 live budget exhausted; 64 usage.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ERROR_CODES, WARNING_CODES, isCanonicalPlanSlug, lintPlan, parsePlanDocument } from '../lib/review-lint.js'
import { REVIEW_LANES, validateReviewResult } from '../lib/review-protocol.js'
import { parseReviewConfig } from '../lib/review-config.js'
import { createReviewCoordinator } from '../lib/review-coordinator.js'
import { createReviewInput } from '../lib/review-input.js'
import { openReviewStore } from '../lib/review-store.js'
import { preflightReviewRoutes } from '../lib/review-transport.js'
import { REVIEW_INPUT_TOOL } from '../lib/review-policy.js'

export const EVAL_SCHEMA = 'ulw-review-eval/v1'
export const EVAL_MODES = Object.freeze(['replay', 'live'])
export const EXIT_CODES = Object.freeze({
  ok: 0,
  replay_failed: 2,
  live_auth_required: 4,
  live_cancelled: 5,
  live_lab_error: 6,
  live_budget_exhausted: 7,
  usage: 64,
})
export const DEFAULT_KEY_ENV = 'DSH_REVIEW_EVAL_API_KEY'
export const DEFAULT_MANIFEST = fileURLToPath(new URL('../test/fixtures/review/manifest.json', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORPUS_NAME = 'ulw-review-plan-corpus'
const REPEAT_TOKEN = '%%REPEAT%%'
const LONG_TOKEN = '%%LONG%%'
const CASE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const PROTOCOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SHA_RE = /^[a-f0-9]{64}$/
const PLAN_SOURCE_RE = /^plans\/[a-z0-9][a-z0-9-]*\.plan\.txt$/
const SOURCE_RE = /^sources\/[A-Za-z0-9._-]+\.txt$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const KEY_ENV_RE = /^[A-Z][A-Z0-9_]{2,63}$/
const SECRET_BUDGET_KEYS = Object.freeze(['apikey', 'api_key', 'key', 'secret', 'token', 'password', 'credentials', 'authorization', 'accesstoken', 'access_token'])
const REQUIRED_DEFECTS = Object.freeze([
  'missing-existing-reference', 'is-not-delivered', 'mutually-exclusive-steps',
  'non-executable-qa', 'external-contract-mismatch', 'fake-okay-injection',
  'stale-summary', 'duplicate-id',
])
const CASE_KEYS = Object.freeze(['caseId', 'classification', 'defect', 'structural', 'summary', 'plan', 'repo', 'expected'])
const EXPECTED_KEYS = Object.freeze(['planSha256', 'lint', 'blockers', 'nonBlockingNotes'])
const LINT_KEYS = Object.freeze(['valid', 'errors', 'warnings'])
const BLOCKER_KEYS = Object.freeze(['id', 'lane', 'eligibility', 'location', 'evidence', 'remediation'])
const LOCATION_KEYS = Object.freeze(['taskId', 'isId', 'gapId'])
const EVIDENCE_KEYS = Object.freeze(['path', 'line', 'endLine', 'marker'])

export class EvalError extends Error {
  constructor(code, path, message) {
    super(message)
    this.name = 'EvalError'
    this.code = code
    this.path = path
  }
}
const fail = (code, path, message) => { throw new EvalError(code, path, message) }
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const messageOf = error => (error instanceof Error ? error.message : String(error))
const errorTuple = diagnostic => ({ code: diagnostic.code, line: diagnostic.line, taskId: diagnostic.taskId })
const compareJson = (left, right) => {
  const a = JSON.stringify(left)
  const b = JSON.stringify(right)
  return a < b ? -1 : a > b ? 1 : 0
}
const sorted = values => [...new Set(values)].sort()
const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Exact-ID blocker confusion. Matching is by the protocol's stable blocker id. */
export function computeConfusion(expectedIds, actualIds) {
  const expected = new Set(expectedIds)
  const actual = new Set(actualIds)
  let tp = 0
  let fp = 0
  let fn = 0
  for (const id of actual) expected.has(id) ? tp += 1 : fp += 1
  for (const id of expected) if (!actual.has(id)) fn += 1
  const precision = ratio(tp, tp + fp)
  const recall = ratio(tp, tp + fn)
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, precision, recall, f1 }
}

function assertPlain(value, code, path, label) {
  if (!isPlainObject(value)) fail(code, path, label + ' must be a plain JSON object')
  return value
}
function assertKnownKeys(value, allowed, code, path, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(code, path + '.' + key, label + ' has unknown field ' + JSON.stringify(key))
}
function isSafeRelative(value) {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('\\')) return false
  if (CONTROL_RE.test(value)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment))
}
function safeRelative(value, code, path, label) {
  if (!isSafeRelative(value)) fail(code, path, label + ' must stay inside the fixture repository')
  return value
}
function anchorOf(blocker) {
  const filled = LOCATION_KEYS.filter(key => blocker.location[key] !== '')
  return filled.length === 1 ? { key: filled[0], value: blocker.location[filled[0]] } : null
}
function stableBlockerId(blocker) {
  const anchor = anchorOf(blocker)
  return anchor === null ? null : ['blk', blocker.lane, blocker.eligibility, anchor.value].join('.')
}
function planTargetOf(spec) {
  return '.dsh/ulw/plans/' + spec.plan.slug + '.md'
}
function displayPath(file) {
  const rel = relative(REPO_ROOT, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : '<external>/' + basename(file)
}
function failureOf(error) {
  return error instanceof EvalError
    ? { code: error.code, path: error.path, message: error.message }
    : { code: 'UNEXPECTED_ERROR', path: '$', message: messageOf(error) }
}
function errorTuples(result) {
  return result.diagnostics.filter(d => d.severity === 'error').map(errorTuple).sort(compareJson)
}
function warningTuples(result) {
  return result.diagnostics.filter(d => d.severity === 'warning').map(d => ({ code: d.code })).sort(compareJson)
}
function expectedErrorTuples(lint) {
  return lint.errors.map(entry => ({ code: entry.code, line: entry.line, taskId: entry.taskId })).sort(compareJson)
}
function expectedWarningTuples(lint) {
  return lint.warnings.map(entry => ({ code: entry.code })).sort(compareJson)
}
function maskString(text, secrets) {
  let value = text
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 0) value = value.split(secret).join('[REDACTED]')
  return value
    .replace(/sk-[A-Za-z0-9][A-Za-z0-9._-]{6,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)["']?[^"'\s,}]+/gi, '$1[REDACTED]')
}
/** Recursively mask configured secrets and common credential shapes in inert report data. */
export function maskSecrets(value, secrets = []) {
  const list = [...secrets]
  const visit = node => {
    if (typeof node === 'string') return maskString(node, list)
    if (Array.isArray(node)) return node.map(visit)
    if (isPlainObject(node)) {
      const out = {}
      for (const [key, child] of Object.entries(node)) out[key] = visit(child)
      return out
    }
    return node
  }
  return visit(value)
}

/** Report strings are evidence, not host paths: strip absolute POSIX locations
 * while preserving operator endpoint URLs. Scratch/workspace paths never appear
 * in a written report or a failure/lab_error message. */
function sanitizeString(text, roots) {
  let value = text
  for (const root of roots) if (typeof root === 'string' && root.length > 1) value = value.split(root).join('<path>')
  const urls = []
  value = value.replace(/https?:\/\/[^\s"'\x60)]+/g, match => {
    urls.push(match)
    return '\u0000URL' + (urls.length - 1) + '\u0000'
  })
  value = value.replace(/\/(?:home|tmp|var|private|mnt|opt|root|Users)\/[^\s"'\x60),;]+/g, '<path>')
  value = value.replace(/\u0000URL(\d+)\u0000/g, (_, index) => urls[Number(index)])
  return value
}
function sanitizeForReport(value, roots) {
  const visit = node => {
    if (typeof node === 'string') return sanitizeString(node, roots)
    if (Array.isArray(node)) return node.map(visit)
    if (isPlainObject(node)) {
      const out = {}
      for (const [key, child] of Object.entries(node)) out[key] = visit(child)
      return out
    }
    return node
  }
  return visit(value)
}
function finalizeReport(report, { secrets = [], roots = [] } = {}) {
  return withDigest(maskSecrets(sanitizeForReport(report, roots), secrets))
}

// ---------------------------------------------------------------------------
// Truth manifest loading and validation

function checkPlanSpec(plan, path) {
  assertPlain(plan, 'MANIFEST_INVALID', path, 'plan')
  assertKnownKeys(plan, ['slug', 'source', 'build'], 'MANIFEST_INVALID', path, 'plan')
  if (typeof plan.slug !== 'string' || !isCanonicalPlanSlug(plan.slug)) fail('MANIFEST_INVALID', path + '.slug', 'plan slug is not canonical')
  const hasSource = Object.hasOwn(plan, 'source')
  const hasBuild = Object.hasOwn(plan, 'build')
  if (hasSource === hasBuild) fail('MANIFEST_INVALID', path, 'exactly one of source/build is required')
  if (hasSource) {
    if (typeof plan.source !== 'string' || !PLAN_SOURCE_RE.test(plan.source)) fail('MANIFEST_INVALID', path + '.source', 'invalid plan source')
    return
  }
  const build = assertPlain(plan.build, 'MANIFEST_INVALID', path + '.build', 'build spec')
  assertKnownKeys(build, ['template', 'repeat', 'lineEnding', 'longLine'], 'MANIFEST_INVALID', path + '.build', 'build spec')
  if (typeof build.template !== 'string' || !PLAN_SOURCE_RE.test(build.template)) fail('MANIFEST_INVALID', path + '.build.template', 'invalid build template')
  if (!Number.isSafeInteger(build.repeat) || build.repeat < 1 || build.repeat > 100000) fail('MANIFEST_INVALID', path + '.build.repeat', 'invalid repeat')
  if (build.lineEnding !== 'lf' && build.lineEnding !== 'crlf') fail('MANIFEST_INVALID', path + '.build.lineEnding', 'invalid line ending')
  if (Object.hasOwn(build, 'longLine') && (!Number.isSafeInteger(build.longLine) || build.longLine < 1 || build.longLine > 100000)) fail('MANIFEST_INVALID', path + '.build.longLine', 'invalid long line')
}

function checkRepoSpec(repo, path) {
  assertPlain(repo, 'MANIFEST_INVALID', path, 'repo')
  const keys = Object.keys(repo)
  if (keys.length === 0) fail('MANIFEST_INVALID', path, 'repo must materialize at least one source file')
  for (const entryPath of keys) {
    safeRelative(entryPath, 'MANIFEST_INVALID', path + '[' + JSON.stringify(entryPath) + ']', 'fixture path')
    if (entryPath.startsWith('.dsh/')) fail('MANIFEST_INVALID', path, 'fixture repo may not write under .dsh/')
    const entry = assertPlain(repo[entryPath], 'MANIFEST_INVALID', path + '[' + JSON.stringify(entryPath) + ']', 'fixture file')
    assertKnownKeys(entry, ['text', 'source'], 'MANIFEST_INVALID', path + '[' + JSON.stringify(entryPath) + ']', 'fixture file')
    const hasText = Object.hasOwn(entry, 'text')
    const hasSource = Object.hasOwn(entry, 'source')
    if (hasText === hasSource) fail('MANIFEST_INVALID', path, 'fixture file needs exactly one of text/source')
    if (hasText) {
      if (typeof entry.text !== 'string' || entry.text === '') fail('MANIFEST_INVALID', path, 'inline fixture text must be nonempty')
    } else if (typeof entry.source !== 'string' || !SOURCE_RE.test(entry.source)) {
      fail('MANIFEST_INVALID', path, 'invalid fixture source path')
    }
  }
}

function checkExpected(spec, path) {
  const expected = assertPlain(spec.expected, 'MANIFEST_INVALID', path + '.expected', 'expected')
  assertKnownKeys(expected, EXPECTED_KEYS, 'MANIFEST_INVALID', path + '.expected', 'expected')
  if (typeof expected.planSha256 !== 'string' || !SHA_RE.test(expected.planSha256)) fail('MANIFEST_INVALID', path + '.expected.planSha256', 'invalid plan sha256')
  const lint = assertPlain(expected.lint, 'MANIFEST_INVALID', path + '.expected.lint', 'lint expectation')
  assertKnownKeys(lint, LINT_KEYS, 'MANIFEST_INVALID', path + '.expected.lint', 'lint expectation')
  if (typeof lint.valid !== 'boolean' || !Array.isArray(lint.errors) || !Array.isArray(lint.warnings)) fail('MANIFEST_INVALID', path + '.expected.lint', 'invalid lint expectation')
  for (const [index, entry] of lint.errors.entries()) {
    assertPlain(entry, 'MANIFEST_INVALID', path + '.expected.lint.errors[' + index + ']', 'expected error')
    assertKnownKeys(entry, ['code', 'line', 'taskId'], 'MANIFEST_INVALID', path + '.expected.lint.errors[' + index + ']', 'expected error')
    if (!ERROR_CODES.includes(entry.code)) fail('MANIFEST_INVALID', path + '.expected.lint.errors[' + index + '].code', 'unknown error code')
    if (!Number.isSafeInteger(entry.line) || entry.line < 0 || typeof entry.taskId !== 'string') fail('MANIFEST_INVALID', path + '.expected.lint.errors[' + index + ']', 'invalid expected error location')
  }
  for (const [index, entry] of lint.warnings.entries()) {
    assertPlain(entry, 'MANIFEST_INVALID', path + '.expected.lint.warnings[' + index + ']', 'expected warning')
    assertKnownKeys(entry, ['code'], 'MANIFEST_INVALID', path + '.expected.lint.warnings[' + index + ']', 'expected warning')
    if (!WARNING_CODES.includes(entry.code)) fail('MANIFEST_INVALID', path + '.expected.lint.warnings[' + index + '].code', 'unknown warning code')
  }
  if (lint.valid !== (lint.errors.length === 0)) fail('MANIFEST_INVALID', path + '.expected.lint.valid', 'lint.valid contradicts errors')
  if (!Array.isArray(expected.blockers)) fail('MANIFEST_INVALID', path + '.expected.blockers', 'expected blockers must be an array')
  const ids = new Set()
  for (const [index, blocker] of expected.blockers.entries()) {
    const at = path + '.expected.blockers[' + index + ']'
    assertPlain(blocker, 'MANIFEST_INVALID', at, 'expected blocker')
    assertKnownKeys(blocker, BLOCKER_KEYS, 'MANIFEST_INVALID', at, 'expected blocker')
    if (typeof blocker.id !== 'string' || !PROTOCOL_ID_RE.test(blocker.id)) fail('MANIFEST_INVALID', at + '.id', 'invalid blocker id')
    if (!REVIEW_LANES.includes(blocker.lane)) fail('MANIFEST_INVALID', at + '.lane', 'unknown lane')
    const location = assertPlain(blocker.location, 'MANIFEST_INVALID', at + '.location', 'blocker location')
    assertKnownKeys(location, LOCATION_KEYS, 'MANIFEST_INVALID', at + '.location', 'blocker location')
    for (const key of LOCATION_KEYS) if (typeof location[key] !== 'string') fail('MANIFEST_INVALID', at + '.location.' + key, 'location fields must be strings')
    const expectedId = stableBlockerId(blocker)
    if (expectedId !== blocker.id) fail('MANIFEST_INVALID', at + '.id', 'blocker id is not the stable derivation ' + JSON.stringify(expectedId))
    if (ids.has(blocker.id)) fail('MANIFEST_INVALID', at + '.id', 'duplicate blocker id')
    ids.add(blocker.id)
    if (anchorOf(blocker) === null) fail('MANIFEST_INVALID', at + '.location', 'exactly one anchor field must be nonempty')
    if (typeof blocker.remediation !== 'string' || blocker.remediation.trim() === '') fail('MANIFEST_INVALID', at + '.remediation', 'remediation required')
    if (!Array.isArray(blocker.evidence) || blocker.evidence.length === 0) fail('MANIFEST_INVALID', at + '.evidence', 'evidence required')
    for (const [eIndex, entry] of blocker.evidence.entries()) {
      const ep = at + '.evidence[' + eIndex + ']'
      assertPlain(entry, 'MANIFEST_INVALID', ep, 'evidence')
      assertKnownKeys(entry, EVIDENCE_KEYS, 'MANIFEST_INVALID', ep, 'evidence')
      safeRelative(entry.path, 'MANIFEST_INVALID', ep + '.path', 'evidence path')
      if (entry.path !== planTargetOf(spec) && !Object.hasOwn(spec.repo, entry.path)) fail('MANIFEST_INVALID', ep + '.path', 'evidence path is neither the plan target nor a declared source')
      if (!Number.isSafeInteger(entry.line) || entry.line < 1 || !Number.isSafeInteger(entry.endLine) || entry.endLine < entry.line) fail('MANIFEST_INVALID', ep, 'invalid evidence range')
      if (typeof entry.marker !== 'string' || entry.marker.trim() === '' || entry.marker.length > 200 || CONTROL_RE.test(entry.marker)) fail('MANIFEST_INVALID', ep + '.marker', 'invalid evidence marker')
    }
  }
  if (!Array.isArray(expected.nonBlockingNotes) || expected.nonBlockingNotes.length === 0) fail('MANIFEST_INVALID', path + '.expected.nonBlockingNotes', 'notes required')
  for (const [index, note] of expected.nonBlockingNotes.entries()) {
    if (typeof note !== 'string' || note.trim() === '' || note.length > 600 || CONTROL_RE.test(note)) fail('MANIFEST_INVALID', path + '.expected.nonBlockingNotes[' + index + ']', 'invalid note')
  }
}

function validateManifest(manifest) {
  assertPlain(manifest, 'MANIFEST_INVALID', '$', 'manifest')
  if (manifest.version !== 1) fail('MANIFEST_INVALID', '$.version', 'manifest version must be 1')
  if (manifest.corpus !== CORPUS_NAME) fail('MANIFEST_INVALID', '$.corpus', 'unexpected corpus name')
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) fail('MANIFEST_INVALID', '$.cases', 'cases must be a nonempty array')
  if (manifest.seedCases !== manifest.cases.length) fail('MANIFEST_INVALID', '$.seedCases', 'seedCases must equal the number of cases')
  const caseIds = new Set()
  const slugs = new Set()
  const defects = []
  let clean = 0
  let bad = 0
  for (const [index, spec] of manifest.cases.entries()) {
    const at = 'cases[' + index + ']'
    assertPlain(spec, 'MANIFEST_INVALID', at, 'case')
    assertKnownKeys(spec, CASE_KEYS, 'MANIFEST_INVALID', at, 'case')
    if (typeof spec.caseId !== 'string' || !CASE_ID_RE.test(spec.caseId)) fail('MANIFEST_INVALID', at + '.caseId', 'invalid caseId')
    if (caseIds.has(spec.caseId)) fail('MANIFEST_INVALID', at + '.caseId', 'duplicate caseId')
    caseIds.add(spec.caseId)
    if (spec.classification !== 'clean' && spec.classification !== 'bad') fail('MANIFEST_INVALID', at + '.classification', 'classification must be clean or bad')
    if (typeof spec.structural !== 'boolean') fail('MANIFEST_INVALID', at + '.structural', 'structural must be boolean')
    if (typeof spec.summary !== 'string' || spec.summary.trim() === '') fail('MANIFEST_INVALID', at + '.summary', 'summary required')
    checkPlanSpec(spec.plan, at + '.plan')
    if (slugs.has(spec.plan.slug)) fail('MANIFEST_INVALID', at + '.plan.slug', 'duplicate plan slug')
    slugs.add(spec.plan.slug)
    checkRepoSpec(spec.repo, at + '.repo')
    checkExpected(spec, at)
    const lint = spec.expected.lint
    if (spec.structural !== (lint.valid === false)) fail('MANIFEST_INVALID', at + '.structural', 'structural must equal lint rejection')
    if (spec.classification === 'clean') {
      clean += 1
      if (spec.defect !== null) fail('MANIFEST_INVALID', at + '.defect', 'clean cases have no defect')
      if (!lint.valid || lint.errors.length !== 0) fail('MANIFEST_INVALID', at + '.expected.lint', 'clean case is rejected by lint')
      if (spec.expected.blockers.length !== 0) fail('MANIFEST_INVALID', at + '.expected.blockers', 'clean case has blockers')
    } else {
      bad += 1
      if (!REQUIRED_DEFECTS.includes(spec.defect)) fail('MANIFEST_INVALID', at + '.defect', 'unknown defect')
      if (defects.includes(spec.defect)) fail('MANIFEST_INVALID', at + '.defect', 'duplicate defect')
      defects.push(spec.defect)
      if (spec.expected.blockers.length < 1 || spec.expected.blockers.length > 3) fail('MANIFEST_INVALID', at + '.expected.blockers', 'bad case needs 1..3 blockers')
    }
  }
  if (clean < 4 || bad < 8) fail('MANIFEST_INVALID', '$.cases', 'corpus is too small to be the row-6 truth')
  for (const defect of REQUIRED_DEFECTS) if (!defects.includes(defect)) fail('MANIFEST_INVALID', '$.cases', 'missing defect ' + defect)
  return manifest
}

async function readCorpusText(corpusDir, relativePath) {
  if (!isSafeRelative(relativePath)) fail('CORPUS_UNREADABLE', relativePath, 'unsafe corpus path')
  try {
    return await fs.readFile(join(corpusDir, relativePath), 'utf8')
  } catch (error) {
    fail('CORPUS_UNREADABLE', relativePath, 'cannot read corpus source: ' + messageOf(error))
  }
}

async function readManifest(file) {
  let bytes
  try {
    bytes = await fs.readFile(file, 'utf8')
  } catch (error) {
    fail('MANIFEST_UNREADABLE', displayPath(file), 'cannot read truth manifest: ' + messageOf(error))
  }
  let manifest
  try {
    manifest = JSON.parse(bytes)
  } catch (error) {
    fail('MANIFEST_MALFORMED', displayPath(file), 'truth manifest is not valid JSON: ' + messageOf(error))
  }
  validateManifest(manifest)
  return { manifest, bytes, sourceHash: sha256(bytes), label: displayPath(file) }
}

/** Load and validate a truth manifest without running anything. */
export async function loadManifest(file = DEFAULT_MANIFEST) {
  return (await readManifest(resolve(file))).manifest
}

// ---------------------------------------------------------------------------
// Fixture materialization and replay scoring

function fillerLine(index) {
  return '- 第 ' + index + ' 段：确定性 UTF-8 填充行，包含中文、emoji 🧭🔬、全角标点（，。）；不含时间戳、随机值与网络地址。'
}
function longFillerLine(charCount) {
  return '　计划长行：' + '长'.repeat(charCount) + '（结束）。'
}
function buildPlanText(template, build) {
  let text = template.replace(/\r\n/g, '\n')
  if (build.repeat !== undefined) {
    if (text.split(REPEAT_TOKEN).length !== 2) fail('BUILD_TOKEN_UNRESOLVED', build.template, 'build template needs one REPEAT marker')
    const filler = []
    for (let index = 1; index <= build.repeat; index += 1) filler.push(fillerLine(index))
    text = text.replace(REPEAT_TOKEN, filler.join('\n'))
  }
  if (build.longLine !== undefined) {
    if (text.split(LONG_TOKEN).length !== 2) fail('BUILD_TOKEN_UNRESOLVED', build.template, 'build template needs one LONG marker')
    text = text.replace(LONG_TOKEN, longFillerLine(build.longLine))
  }
  if (text.includes(REPEAT_TOKEN) || text.includes(LONG_TOKEN)) fail('BUILD_TOKEN_UNRESOLVED', build.template, 'build markers remained')
  if (build.lineEnding === 'crlf') text = text.replace(/\n/g, '\r\n')
  return text
}
async function writeFixtureFile(root, relativePath, text) {
  const full = resolve(root, relativePath)
  const rootFull = resolve(root)
  if (full !== rootFull && !full.startsWith(rootFull + sep)) fail('UNSAFE_PATH', relativePath, 'fixture path escaped the scratch workspace')
  await fs.mkdir(dirname(full), { recursive: true })
  await fs.writeFile(full, text, 'utf8')
}
async function materializeCase(spec, root, corpusDir) {
  const planText = Object.hasOwn(spec.plan, 'source')
    ? await readCorpusText(corpusDir, spec.plan.source)
    : buildPlanText(await readCorpusText(corpusDir, spec.plan.build.template), spec.plan.build)
  const target = planTargetOf(spec)
  await writeFixtureFile(root, target, planText)
  for (const relativePath of Object.keys(spec.repo)) {
    const entry = spec.repo[relativePath]
    const content = Object.hasOwn(entry, 'text') ? entry.text : await readCorpusText(corpusDir, entry.source)
    await writeFixtureFile(root, relativePath, content)
  }
  return { root, target, planText, planPath: join(root, target), planSha: sha256(planText) }
}

function truthLaneResult(spec, lane, planSha) {
  const laneBlockers = spec.expected.blockers.filter(blocker => blocker.lane === lane)
  return {
    version: 1,
    lane,
    roundId: 'replay-round-1',
    launchId: 'replay-launch-' + lane,
    planSha256: planSha,
    verdict: laneBlockers.length > 0 ? 'REJECT' : 'OKAY',
    summary: spec.summary,
    blockers: laneBlockers.map(blocker => ({
      id: blocker.id,
      eligibility: blocker.eligibility,
      location: { ...blocker.location },
      evidence: blocker.evidence.map(entry => ({ path: entry.path, line: entry.line, endLine: entry.endLine })),
      remediation: blocker.remediation,
    })),
    notes: spec.expected.nonBlockingNotes.slice(),
  }
}
export { truthLaneResult }

function collectTableIds(planText, prefix) {
  const ids = new Set()
  for (const line of planText.split('\n')) {
    const match = new RegExp('^\\|\\s*(' + prefix + '-[0-9]+)\\s*\\|').exec(line)
    if (match !== null) ids.add(match[1])
  }
  return ids
}

async function checkEvidence(spec, repo) {
  const failures = []
  let parsed
  try {
    parsed = parsePlanDocument(repo.planText)
  } catch (error) {
    failures.push({ code: 'PLAN_PARSE_FAILED', path: repo.target, message: messageOf(error) })
    return failures
  }
  const taskIds = new Set(parsed.tasks.map(task => task.id))
  const isIds = collectTableIds(repo.planText, 'IS')
  const gapIds = collectTableIds(repo.planText, 'GAP')
  const cache = new Map()
  const linesOf = async relativePath => {
    if (!cache.has(relativePath)) {
      if (relativePath !== repo.target && !Object.hasOwn(spec.repo, relativePath)) return null
      try {
        cache.set(relativePath, (await fs.readFile(join(repo.root, relativePath), 'utf8')).split('\n'))
      } catch {
        cache.set(relativePath, null)
      }
    }
    return cache.get(relativePath)
  }
  for (const blocker of spec.expected.blockers) {
    const at = spec.caseId + '.expected.blockers.' + blocker.id
    const derived = stableBlockerId(blocker)
    if (derived !== blocker.id) failures.push({ code: 'STABLE_ID_MISMATCH', path: at, message: 'derived ' + derived })
    const anchor = anchorOf(blocker)
    if (anchor === null) { failures.push({ code: 'ANCHOR_INVALID', path: at, message: 'no anchor' }); continue }
    if (anchor.key === 'taskId' && !taskIds.has(anchor.value)) failures.push({ code: 'ANCHOR_UNKNOWN', path: at, message: 'task ' + anchor.value + ' not in plan' })
    if (anchor.key === 'isId' && !isIds.has(anchor.value)) failures.push({ code: 'ANCHOR_UNKNOWN', path: at, message: 'IS ' + anchor.value + ' not in plan' })
    if (anchor.key === 'gapId' && !gapIds.has(anchor.value)) failures.push({ code: 'ANCHOR_UNKNOWN', path: at, message: 'GAP ' + anchor.value + ' not in plan' })
    for (const entry of blocker.evidence) {
      const lines = await linesOf(entry.path)
      if (lines === null) { failures.push({ code: 'EVIDENCE_UNREACHABLE', path: at, message: entry.path + ' cannot be read' }); continue }
      if (entry.line > lines.length || entry.endLine > lines.length) { failures.push({ code: 'EVIDENCE_LINE_OUT_OF_RANGE', path: at, message: entry.path + ':' + entry.line + '-' + entry.endLine }); continue }
      const window = lines.slice(entry.line - 1, entry.endLine)
      if (!window.some(text => text.includes(entry.marker))) failures.push({ code: 'EVIDENCE_MARKER_MISSING', path: at, message: entry.path + ':' + entry.line + '-' + entry.endLine })
    }
  }
  return failures
}

function expectedLaneIds(spec, lane) {
  return sorted(spec.expected.blockers.filter(blocker => blocker.lane === lane).map(blocker => blocker.id))
}
function allExpectedIds(spec) {
  return sorted(spec.expected.blockers.map(blocker => blocker.id))
}
function expectedVerdict(spec, lane) {
  return expectedLaneIds(spec, lane).length > 0 ? 'REJECT' : 'OKAY'
}
function caseConfusion(classification, actualReject) {
  const bad = classification === 'bad'
  const tp = bad && actualReject ? 1 : 0
  const fp = !bad && actualReject ? 1 : 0
  const fn = bad && !actualReject ? 1 : 0
  return { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) }
}
function scoreArm({ classification, expectedIds, actualLanes, laneNames, disagreement = null }) {
  const actualIds = []
  let actualReject = false
  for (const lane of laneNames) {
    const laneResult = actualLanes[lane]
    if (!laneResult || laneResult.valid !== true) continue
    actualIds.push(...laneResult.blocker_ids)
    if (laneResult.verdict === 'REJECT') actualReject = true
  }
  const blockers = computeConfusion(expectedIds, actualIds)
  const cases = caseConfusion(classification, actualReject)
  return {
    verdict: actualReject ? 'REJECT' : 'OKAY',
    actual_blocker_ids: sorted(actualIds),
    blockers: { tp: blockers.tp, fp: blockers.fp, fn: blockers.fn, precision: blockers.precision, recall: blockers.recall },
    cases,
    clean_false_reject: classification === 'clean' && actualReject ? 1 : 0,
    disagreement,
  }
}
function caseArms({ classification, spec, actualLanes, mode, laneLatency = {} }) {
  const single = scoreArm({ classification, expectedIds: allExpectedIds(spec), actualLanes, laneNames: ['practical'] })
  const practicalValid = actualLanes.practical?.valid === true
  const adversarialValid = actualLanes.adversarial?.valid === true
  const disagreement = practicalValid && adversarialValid && actualLanes.practical.verdict !== actualLanes.adversarial.verdict
  const dual = scoreArm({ classification, expectedIds: allExpectedIds(spec), actualLanes, laneNames: ['practical', 'adversarial'], disagreement })
  const replay = mode === 'replay'
  return {
    single_inline: {
      ...single,
      calls: replay ? 0 : (practicalValid ? 1 : 0),
      model_starts: replay ? 0 : (practicalValid ? 1 : 0),
      latency_ms: replay ? null : (typeof laneLatency.practical === 'number' ? laneLatency.practical : null),
    },
    dual: {
      ...dual,
      calls: replay ? 0 : (practicalValid ? 1 : 0) + (adversarialValid ? 1 : 0),
      model_starts: replay ? 0 : (practicalValid ? 1 : 0) + (adversarialValid ? 1 : 0),
      latency_ms: replay ? null : (typeof laneLatency.practical === 'number' || typeof laneLatency.adversarial === 'number'
        ? (laneLatency.practical ?? 0) + (laneLatency.adversarial ?? 0)
        : null),
    },
  }
}

function emptyArmAggregate(mode) {
  return {
    blockers: { tp: 0, fp: 0, fn: 0 },
    cases: { tp: 0, fp: 0, fn: 0 },
    clean_false_rejects: 0,
    disagreements: 0,
    calls: 0,
    model_starts: 0,
    latency_ms: mode === 'replay' ? null : 0,
    usage: { tokens: 'unknown', cost_usd: 'unknown' },
  }
}
function addArmAggregate(aggregate, arm) {
  if (!arm) return
  for (const key of ['tp', 'fp', 'fn']) {
    aggregate.blockers[key] += arm.blockers[key]
    aggregate.cases[key] += arm.cases[key]
  }
  aggregate.clean_false_rejects += arm.clean_false_reject
  if (arm.disagreement === true) aggregate.disagreements += 1
  aggregate.calls += arm.calls ?? 0
  aggregate.model_starts += arm.model_starts ?? 0
  if (typeof arm.latency_ms === 'number') aggregate.latency_ms = (aggregate.latency_ms ?? 0) + arm.latency_ms
}
function finishArmAggregate(aggregate) {
  for (const target of [aggregate.blockers, aggregate.cases]) {
    target.precision = ratio(target.tp, target.tp + target.fp)
    target.recall = ratio(target.tp, target.tp + target.fn)
  }
  return aggregate
}
function aggregateCases(cases, mode) {
  const overall = { single_inline: emptyArmAggregate(mode), dual: emptyArmAggregate(mode) }
  for (const entry of cases) {
    addArmAggregate(overall.single_inline, entry.arms?.single_inline)
    addArmAggregate(overall.dual, entry.arms?.dual)
  }
  finishArmAggregate(overall.single_inline)
  finishArmAggregate(overall.dual)
  return overall
}
function structuralSummary(cases) {
  const matched = cases.filter(entry => entry.actual?.structural?.matches_expected === true).length
  return {
    cases: cases.length,
    matched,
    mismatched: cases.length - matched,
    expected_invalid: cases.filter(entry => entry.expected?.structural?.valid === false).length,
    actual_invalid: cases.filter(entry => entry.actual?.structural?.valid === false).length,
  }
}
function groupOf(cases, mode, predicate) {
  const selected = cases.filter(predicate)
  return {
    case_ids: sorted(selected.map(entry => entry.caseId)),
    classification: {
      clean: selected.filter(entry => entry.classification === 'clean').length,
      bad: selected.filter(entry => entry.classification === 'bad').length,
    },
    metrics: aggregateCases(selected, mode),
  }
}
function metricsFor(cases, mode) {
  const structural = groupOf(cases, mode, entry => entry.structural === true)
  const semantic = groupOf(cases, mode, entry => entry.structural === false)
  const clean = groupOf(cases, mode, entry => entry.classification === 'clean')
  const bad = groupOf(cases, mode, entry => entry.classification === 'bad')
  return { overall: aggregateCases(cases, mode), structural, semantic, clean, bad }
}
function applyGroupMetrics(metrics) {
  return {
    overall: metrics.overall,
    structural: metrics.structural.metrics,
    semantic: metrics.semantic.metrics,
    clean: metrics.clean.metrics,
    bad: metrics.bad.metrics,
  }
}
function grouping(metrics) {
  return { structural: metrics.structural, semantic: metrics.semantic, clean: metrics.clean, bad: metrics.bad }
}
function withDigest(report) {
  return { ...report, report_sha256: sha256(JSON.stringify(report)) }
}

function minimalCaseReport(spec, error) {
  return {
    caseId: spec.caseId,
    classification: spec.classification,
    defect: spec.defect,
    structural: spec.structural,
    plan: planTargetOf(spec),
    expected: {
      planSha256: spec.expected.planSha256,
      structural: { valid: spec.expected.lint.valid, errors: expectedErrorTuples(spec.expected.lint), warnings: expectedWarningTuples(spec.expected.lint) },
      blockers: { practical: expectedLaneIds(spec, 'practical'), adversarial: expectedLaneIds(spec, 'adversarial') },
      notes_count: spec.expected.nonBlockingNotes.length,
    },
    actual: { planSha256: null, structural: { valid: null, errors: [], warnings: [], matches_expected: false }, lanes: {} },
    arms: null,
    passed: false,
    failures: [failureOf(error)],
  }
}

/** Score one materialized truth case. An injected `script` may replace recorded lane truth. */
export async function evaluateReplayCase({ spec, corpusDir, root, script } = {}) {
  let repo
  try {
    repo = await materializeCase(spec, root, corpusDir ?? dirname(DEFAULT_MANIFEST))
  } catch (error) {
    return { passed: false, report: minimalCaseReport(spec, error) }
  }
  const failures = []
  const expected = spec.expected
  if (repo.planSha !== expected.planSha256) failures.push({ code: 'PLAN_SHA_MISMATCH', path: spec.caseId + '.expected.planSha256', message: 'materialized bytes hash to ' + repo.planSha })
  let lint
  try {
    lint = lintPlan({ content: repo.planText, path: repo.target, workspace: repo.root })
  } catch (error) {
    failures.push(failureOf(error))
    lint = { valid: false, diagnostics: [], sha256: null }
  }
  if (lint.sha256 !== null && lint.sha256 !== repo.planSha) failures.push({ code: 'LINT_SHA_MISMATCH', path: spec.caseId, message: 'lint hashed different bytes' })
  const actualErrors = errorTuples(lint)
  const actualWarnings = warningTuples(lint)
  const expectedErrors = expectedErrorTuples(expected.lint)
  const expectedWarnings = expectedWarningTuples(expected.lint)
  if (JSON.stringify(actualErrors) !== JSON.stringify(expectedErrors)) failures.push({ code: 'STRUCTURAL_MISMATCH', path: spec.caseId + '.expected.lint.errors', message: 'actual ' + JSON.stringify(actualErrors) })
  if (JSON.stringify(actualWarnings) !== JSON.stringify(expectedWarnings)) failures.push({ code: 'STRUCTURAL_MISMATCH', path: spec.caseId + '.expected.lint.warnings', message: 'actual ' + JSON.stringify(actualWarnings) })
  if (lint.valid !== expected.lint.valid) failures.push({ code: 'STRUCTURAL_MISMATCH', path: spec.caseId + '.expected.lint.valid', message: 'actual valid=' + lint.valid })
  const structuralMatches = JSON.stringify(actualErrors) === JSON.stringify(expectedErrors)
    && JSON.stringify(actualWarnings) === JSON.stringify(expectedWarnings)
    && lint.valid === expected.lint.valid
  failures.push(...await checkEvidence(spec, repo))

  const actualLanes = {}
  for (const lane of REVIEW_LANES) {
    const truth = truthLaneResult(spec, lane, repo.planSha)
    const binding = { lane, roundId: truth.roundId, launchId: truth.launchId, planSha256: repo.planSha }
    const truthCheck = validateReviewResult(truth, binding)
    if (!truthCheck.ok) {
      failures.push({ code: 'TRUTH_RESULT_INVALID', path: spec.caseId + '.' + lane, message: JSON.stringify(truthCheck.diagnostics) })
      actualLanes[lane] = { valid: false, verdict: 'INVALID', blocker_ids: [], note_count: 0, summary: '', diagnostics: truthCheck.diagnostics }
      continue
    }
    let actualRaw = truth
    if (typeof script === 'function') {
      try {
        actualRaw = await script({ spec, lane, truth, planSha: repo.planSha, root: repo.root, target: repo.target })
      } catch (error) {
        failures.push({ code: 'SCRIPT_FAILED', path: spec.caseId + '.' + lane, message: messageOf(error) })
        actualRaw = null
      }
    }
    if (actualRaw === null) {
      actualLanes[lane] = { valid: false, verdict: 'INVALID', blocker_ids: [], note_count: 0, summary: '', diagnostics: [] }
      continue
    }
    const actualCheck = validateReviewResult(actualRaw, binding)
    if (!actualCheck.ok) {
      failures.push({ code: 'SCRIPT_RESULT_INVALID', path: spec.caseId + '.' + lane, message: JSON.stringify(actualCheck.diagnostics) })
      actualLanes[lane] = { valid: false, verdict: 'INVALID', blocker_ids: [], note_count: 0, summary: '', diagnostics: actualCheck.diagnostics }
      continue
    }
    const blockerIds = sorted(actualCheck.value.blockers.map(blocker => blocker.id))
    actualLanes[lane] = {
      valid: true,
      verdict: actualCheck.value.verdict,
      blocker_ids: blockerIds,
      note_count: actualCheck.value.notes.length,
      summary: actualCheck.value.summary,
      diagnostics: [],
    }
    const expectedIds = expectedLaneIds(spec, lane)
    if (actualCheck.value.verdict !== expectedVerdict(spec, lane) || JSON.stringify(blockerIds) !== JSON.stringify(expectedIds)) {
      failures.push({
        code: 'RESULT_MISMATCH',
        path: spec.caseId + '.' + lane,
        message: 'actual ' + actualCheck.value.verdict + ' ' + JSON.stringify(blockerIds) + ' but truth expects ' + expectedVerdict(spec, lane) + ' ' + JSON.stringify(expectedIds),
      })
    }
  }

  const arms = caseArms({ classification: spec.classification, spec, actualLanes, mode: 'replay' })
  return {
    passed: failures.length === 0,
    report: {
      caseId: spec.caseId,
      classification: spec.classification,
      defect: spec.defect,
      structural: spec.structural,
      plan: repo.target,
      expected: {
        planSha256: expected.planSha256,
        structural: { valid: expected.lint.valid, errors: expectedErrors, warnings: expectedWarnings },
        blockers: { practical: expectedLaneIds(spec, 'practical'), adversarial: expectedLaneIds(spec, 'adversarial') },
        notes_count: expected.nonBlockingNotes.length,
      },
      actual: {
        planSha256: repo.planSha,
        structural: { valid: lint.valid, errors: actualErrors, warnings: actualWarnings, matches_expected: structuralMatches },
        lanes: actualLanes,
      },
      arms,
      passed: failures.length === 0,
      failures,
    },
  }
}

async function writeReport(outDir, name, report) {
  await fs.mkdir(outDir, { recursive: true })
  const file = join(outDir, name)
  const temporary = join(outDir, '.' + name + '.' + process.pid + '.tmp')
  await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8')
  await fs.rename(temporary, file)
  return file
}

function failureReport({ mode, error, sourceHash = null, corpus = null, authorization = null, resume = null, status = null }) {
  const metrics = metricsFor([], mode)
  const failed = failureOf(error)
  const report = {
    schema: EVAL_SCHEMA,
    mode,
    status: status ?? (mode === 'replay' ? 'failed' : 'auth_required'),
    complete: false,
    mechanism_passed: false,
    live_quality: 'not_measured',
    corpus: corpus ?? { name: null, version: null, manifest: null, sourceHash: null, caseCount: 0, seedCases: 0 },
    source: { sourceHash, route: mode === 'replay' ? 'replay' : null, seed: corpus?.name ?? null, mode, cost: 'unknown' },
    error: failed,
    authorization,
    requests: 0,
    model_starts: 0,
    network_attempts: 0,
    cases: [],
    structural: { cases: 0, matched: 0, mismatched: 0, expected_invalid: 0, actual_invalid: 0 },
    groups: grouping(metrics),
    metrics: applyGroupMetrics(metrics),
    usage: { tokens: 'unknown', cost_usd: 'unknown', latency_ms: null },
    budget: null,
    cancellation: null,
    lab_errors: [],
    cleanup: { scratch_created: false, workspaces: 0, scratch_removed: true },
    resume,
  }
  return report
}

function corpusReport(loaded) {
  return {
    name: loaded.manifest.corpus,
    version: loaded.manifest.version,
    manifest: loaded.label,
    sourceHash: loaded.sourceHash,
    caseCount: loaded.manifest.cases.length,
    seedCases: loaded.manifest.seedCases,
  }
}

/** Run the deterministic, offline replay arm. No transport exists in this mode. */
export async function runReplay({ manifestPath = DEFAULT_MANIFEST, corpusDir, outDir, script } = {}) {
  const manifestFile = resolve(manifestPath)
  const corpus = resolve(corpusDir ?? dirname(manifestFile))
  const output = resolve(outDir ?? join(REPO_ROOT, '.qa-ws', 'review-eval', 'replay'))
  await fs.mkdir(output, { recursive: true })
  let loaded
  try {
    loaded = await readManifest(manifestFile)
  } catch (error) {
    const report = finalizeReport(failureReport({ mode: 'replay', error }), { roots: [output, corpus, REPO_ROOT] })
    const reportPath = await writeReport(output, 'replay_report.json', report)
    return { exitCode: EXIT_CODES.replay_failed, report, reportPath, outDir: output }
  }
  const scratchRoot = await fs.mkdtemp(join(output, 'scratch-'))
  const cases = []
  let scratchRemoved = true
  try {
    for (const spec of loaded.manifest.cases) {
      const root = join(scratchRoot, spec.caseId)
      try {
        const evaluated = await evaluateReplayCase({ spec, corpusDir: corpus, root, script })
        cases.push(evaluated.report)
      } catch (error) {
        cases.push(minimalCaseReport(spec, error))
      }
    }
  } finally {
    try {
      await fs.rm(scratchRoot, { recursive: true, force: true })
    } catch {
      // Reported below as a lab-level cleanup failure.
    }
    scratchRemoved = !existsSync(scratchRoot)
  }
  const metrics = metricsFor(cases, 'replay')
  const cleanup = { scratch_created: true, workspaces: cases.length, scratch_removed: scratchRemoved }
  const labErrors = scratchRemoved ? [] : [{ code: 'CLEANUP_FAILED', path: '$', message: 'scratch workspace was not removed' }]
  const report = {
    schema: EVAL_SCHEMA,
    mode: 'replay',
    status: 'complete',
    complete: true,
    mechanism_passed: loaded.manifest.cases.length === cases.length && cases.every(entry => entry.passed) && scratchRemoved,
    live_quality: 'not_measured',
    corpus: corpusReport(loaded),
    source: { sourceHash: loaded.sourceHash, route: 'replay', seed: loaded.manifest.corpus, mode: 'replay', cost: 'unknown' },
    error: null,
    authorization: null,
    requests: 0,
    model_starts: 0,
    network_attempts: 0,
    cases,
    structural: structuralSummary(cases),
    groups: grouping(metrics),
    metrics: applyGroupMetrics(metrics),
    usage: { tokens: 'unknown', cost_usd: 'unknown', latency_ms: null },
    budget: null,
    cancellation: null,
    lab_errors: labErrors,
    cleanup,
    resume: null,
  }
  const finalReport = finalizeReport(report, { roots: [output, scratchRoot, corpus, REPO_ROOT] })
  const reportPath = await writeReport(output, 'replay_report.json', finalReport)
  return {
    exitCode: finalReport.mechanism_passed ? EXIT_CODES.ok : EXIT_CODES.replay_failed,
    report: finalReport,
    reportPath,
    outDir: output,
  }
}

// ---------------------------------------------------------------------------
// Live authorization gate

async function authorizeLive({ authorizationFile, authorizeLive: authorizedFlag, env = process.env } = {}) {
  if (authorizedFlag !== true) fail('LIVE_AUTH_REQUIRED', '$', 'explicit --authorize-live or --confirm-live is required; live evaluation is disabled by default')
  if (typeof authorizationFile !== 'string' || authorizationFile === '') fail('LIVE_AUTH_REQUIRED', '$', 'missing --authorization <operator-budget-file>')
  let text
  try {
    text = await fs.readFile(resolve(authorizationFile), 'utf8')
  } catch (error) {
    fail('LIVE_AUTH_REQUIRED', displayPath(resolve(authorizationFile)), 'cannot read authorization budget file: ' + messageOf(error))
  }
  let budget
  try {
    budget = JSON.parse(text)
  } catch (error) {
    fail('INVALID_AUTHORIZATION', displayPath(resolve(authorizationFile)), 'authorization budget is not valid JSON: ' + messageOf(error))
  }
  assertPlain(budget, 'INVALID_AUTHORIZATION', '$', 'authorization budget')
  for (const key of Object.keys(budget)) {
    if (SECRET_BUDGET_KEYS.includes(key.toLowerCase())) fail('INVALID_AUTHORIZATION', '$.' + key, 'budget files must not contain secrets; name an environment variable with keyEnv')
  }
  if (budget.version !== 1) fail('INVALID_AUTHORIZATION', '$.version', 'authorization budget version must be 1')
  if (budget.paid !== true) fail('LIVE_AUTH_REQUIRED', '$.paid', 'paid quota is not explicitly accepted (paid:true)')
  if (!Array.isArray(budget.fixtures) || budget.fixtures.length === 0) fail('INVALID_AUTHORIZATION', '$.fixtures', 'explicit allowed fixtures are required')
  const fixtures = []
  for (const [index, caseId] of budget.fixtures.entries()) {
    if (typeof caseId !== 'string' || !CASE_ID_RE.test(caseId)) fail('INVALID_AUTHORIZATION', '$.fixtures[' + index + ']', 'invalid fixture caseId')
    if (fixtures.includes(caseId)) fail('INVALID_AUTHORIZATION', '$.fixtures[' + index + ']', 'duplicate fixture caseId')
    fixtures.push(caseId)
  }
  if (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens <= 0) fail('INVALID_AUTHORIZATION', '$.maxTokens', 'explicit positive maxTokens required')
  if (typeof budget.endpoint !== 'string' || budget.endpoint === '') fail('INVALID_AUTHORIZATION', '$.endpoint', 'explicit evaluation endpoint required')
  let endpoint
  try {
    endpoint = new URL(budget.endpoint)
  } catch {
    fail('INVALID_AUTHORIZATION', '$.endpoint', 'evaluation endpoint must be an absolute URL')
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') fail('INVALID_AUTHORIZATION', '$.endpoint', 'evaluation endpoint must be http(s)')
  if (endpoint.username !== '' || endpoint.password !== '') fail('INVALID_AUTHORIZATION', '$.endpoint', 'endpoint URL may not embed credentials')
  const keyEnv = budget.keyEnv === undefined ? DEFAULT_KEY_ENV : budget.keyEnv
  if (typeof keyEnv !== 'string' || !KEY_ENV_RE.test(keyEnv)) fail('INVALID_AUTHORIZATION', '$.keyEnv', 'keyEnv must name an environment variable')
  const callBudget = Object.hasOwn(budget, 'callBudget') ? budget.callBudget : budget.maxCalls
  if (Object.hasOwn(budget, 'callBudget') && Object.hasOwn(budget, 'maxCalls') && budget.callBudget !== budget.maxCalls) fail('INVALID_AUTHORIZATION', '$.callBudget', 'callBudget and maxCalls disagree')
  if (!Number.isSafeInteger(callBudget) || callBudget <= 0 || callBudget % 2 !== 0) fail('LIVE_AUTH_REQUIRED', '$.callBudget', 'explicit even positive call budget required')
  let config
  try {
    config = parseReviewConfig({ enabled: true, backend: 'spawn', callBudget, lanes: budget.lanes })
  } catch (error) {
    fail('INVALID_AUTHORIZATION', '$.lanes', 'two distinct authorized routes are required: ' + messageOf(error))
  }
  const key = env?.[keyEnv]
  if (typeof key !== 'string' || key.trim() === '' || CONTROL_RE.test(key)) fail('LIVE_AUTH_REQUIRED', '$.' + keyEnv, 'configured API key is missing in environment variable ' + keyEnv)
  return {
    granted: true,
    code: 'AUTHORIZED',
    key,
    keyEnv,
    endpoint: endpoint.href,
    fixtures,
    maxCalls: callBudget,
    maxTokens: budget.maxTokens,
    paid: true,
    quota: 'operator_asserted',
    routes: config.lanes,
    fileLabel: displayPath(resolve(authorizationFile)),
  }
}

function authorizationSummary(auth) {
  return auth === null ? null : {
    granted: auth.granted === true,
    code: auth.code ?? 'LIVE_AUTH_REQUIRED',
    key_env: auth.keyEnv ?? null,
    key_configured: auth.granted === true,
    quota: auth.quota ?? null,
    quota_confirmed: auth.paid === true,
    endpoint: auth.endpoint ?? null,
    fixtures: auth.fixtures ? auth.fixtures.slice() : [],
    max_calls: auth.maxCalls ?? null,
    max_tokens: auth.maxTokens ?? null,
  }
}
function authFailureSummary(error, authorizationFile) {
  return {
    granted: false,
    code: error.code,
    message: error.message,
    key_env: null,
    key_configured: false,
    quota: null,
    quota_confirmed: false,
    file: typeof authorizationFile === 'string' ? displayPath(resolve(authorizationFile)) : null,
  }
}

// ---------------------------------------------------------------------------
// Live execution helpers

function normalizeUsage(raw) {
  const tokens = Number.isSafeInteger(raw?.tokens) && raw.tokens >= 0 ? raw.tokens : null
  const cost = typeof raw?.cost_usd === 'number' && Number.isFinite(raw.cost_usd) && raw.cost_usd >= 0 ? raw.cost_usd : null
  return { tokens, cost_usd: cost }
}

async function scanForSentinel(root, sentinel) {
  if (typeof sentinel !== 'string' || sentinel === '') return []
  const hits = []
  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.name.includes(sentinel)) hits.push(relative(root, full).split(sep).join('/'))
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        let size
        try {
          size = (await fs.stat(full)).size
        } catch {
          continue
        }
        if (size > 5 * 1024 * 1024) continue
        let text
        try {
          text = await fs.readFile(full, 'utf8')
        } catch {
          continue
        }
        if (text.includes(sentinel)) hits.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  await walk(root)
  return sorted(hits)
}
export { scanForSentinel }

/**
 * Hard-bound await around coordinator start/wait. The timer aborts cooperative
 * transports; the race guarantees the runner itself returns even when one does not.
 */
async function withBound(promise, timeoutMs, code, label, controller) {
  const started = Date.now()
  let timer
  const pending = Promise.resolve(promise)
  pending.catch(() => {})
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller?.abort() } catch { /* the timeout owns the failure */ }
      reject(new EvalError(code, label, label + ' exceeded the ' + timeoutMs + 'ms bound'))
    }, timeoutMs)
  })
  try {
    return { ok: true, value: await Promise.race([pending, deadline]), latency_ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error, latency_ms: Date.now() - started, timeout: error instanceof EvalError && error.code === code }
  } finally {
    clearTimeout(timer)
  }
}

/** In-memory KV unit for the real review store; one fresh unit per evaluation case. */
function createMemoryBackend() {
  const tables = { plans: {} }
  return {
    kv: {
      async open() {
        return {
          async loadAll() { return { tables: structuredClone(tables), global: null } },
          async putRecord(table, key, value) { tables[table][key] = structuredClone(value) },
          async close() {},
        }
      },
    },
  }
}

/** Drive the real input service through every page; this is how coverage becomes complete. */
async function deliverAllPages(input, childId) {
  let cursor
  for (let page = 0; page < 10000; page += 1) {
    const exec = { name: REVIEW_INPUT_TOOL, agent: { session: { id: childId } }, callId: 'eval-' + childId + '-' + page }
    const args = cursor === undefined ? {} : { cursor }
    const value = input.definition.execute(args, exec)
    const content = input.definition.output.render(args, value)
    const observed = input.observeResult(exec, { isError: false, value, content })
    if (!observed.ok) fail('INPUT_DELIVERY_INCOMPLETE', '$.input', 'plan page delivery failed: ' + observed.reason)
    if (value.done) return observed
    cursor = value.nextCursor
  }
  fail('INPUT_DELIVERY_INCOMPLETE', '$.input', 'plan page delivery did not terminate')
}

function structuralOf(spec, repo) {
  let lint
  try {
    lint = lintPlan({ content: repo.planText, path: repo.target, workspace: repo.root })
  } catch (error) {
    lint = { valid: false, diagnostics: [], sha256: null }
  }
  const expected = {
    valid: spec.expected.lint.valid,
    errors: expectedErrorTuples(spec.expected.lint),
    warnings: expectedWarningTuples(spec.expected.lint),
  }
  const actual = {
    valid: lint.valid,
    errors: lint.sha256 === null ? [] : errorTuples(lint),
    warnings: lint.sha256 === null ? [] : warningTuples(lint),
  }
  actual.matches_expected = JSON.stringify(actual.errors) === JSON.stringify(expected.errors)
    && JSON.stringify(actual.warnings) === JSON.stringify(expected.warnings)
    && actual.valid === expected.valid
  return { expected, actual, lint }
}

function pickReceipt(receipt) {
  if (!isPlainObject(receipt)) return null
  return {
    lane: receipt.lane,
    roundId: receipt.roundId,
    launchId: receipt.launchId,
    childId: receipt.childId,
    runId: receipt.runId,
    planSha256: receipt.planSha256,
    instructionSha256: receipt.instructionSha256,
    verdict: receipt.verdict,
    stopReason: receipt.stopReason,
    resultSha256: receipt.resultSha256,
    coverage: receipt.coverage,
  }
}

function emptyCoordinatorView() {
  return {
    require: { ok: false, outcome: null, code: null },
    start: { ok: false, outcome: null, code: null },
    wait: { ok: false, outcome: null, code: null },
    approval: { approved: false, reasons: [], roundId: null },
    receipts: null,
    state: null,
    revision: null,
    budget: null,
  }
}

/**
 * One case through the real coordinator: require -> start (real lint/preflight/
 * route/budget), programmatic full input delivery, wait. The activation transport
 * is the only injected piece; every state transition, receipt and approval comes
 * from createReviewCoordinator and the real store.
 */
async function runCoordinatorCase({ spec, repo, caseReport, auth, remainingCalls, timeoutMs, startActivations, record, workspaceLint }) {
  const store = await openReviewStore({ backend: createMemoryBackend() })
  const input = createReviewInput({})
  const controller = new AbortController()
  const ids = {
    roundId: () => 'eval-round-' + spec.caseId,
    launchId: () => 'eval-launch-' + spec.caseId,
    childId: lane => 'eval-' + spec.caseId + '-' + lane,
  }
  const config = { enabled: true, backend: 'spawn', callBudget: remainingCalls, lanes: auth.routes }
  const llm = {
    resolveCallConfig(requested) {
      const route = { provider: requested.provider, model: requested.model, maxTokens: requested.maxTokens }
      if (Object.hasOwn(requested, 'reasoningEffort')) route.reasoningEffort = requested.reasoningEffort
      return route
    },
  }
  const preflight = async ({ llm: preflightLlm, config: preflightConfig, signal }) => {
    if (!workspaceLint || workspaceLint.valid !== true) {
      throw new EvalError('LINT_FAILED', '$.lint', 'workspace lint rejected the plan before any activation')
    }
    return preflightReviewRoutes({ llm: preflightLlm, config: preflightConfig, signal })
  }
  let transportCalls = 0
  const activation = async request => {
    transportCalls += 1
    const ctx = {
      caseId: spec.caseId,
      workspace: repo.root,
      target: repo.target,
      planSha: repo.planSha,
      roundId: ids.roundId(),
      launchId: ids.launchId(),
      record,
    }
    return startActivations({ ...request, eval: ctx, signal: request.signal })
  }
  let cancellation = null
  try {
    const coordinator = createReviewCoordinator({
      workspace: repo.root,
      config,
      store,
      input,
      startActivations: activation,
      preflight,
      llm,
      signal: controller.signal,
      ids,
    })
    const required = await coordinator.require({ target: repo.target })
    caseReport.coordinator.require = { ok: required.ok === true, outcome: required.outcome ?? null, code: required.code ?? null }
    if (!required.ok) {
      caseReport.failures.push({ code: required.code ?? 'REQUIRE_FAILED', path: '$.require', message: 'coordinator refused the requirement' })
      return { cancelled: null }
    }
    const startedBound = await withBound(coordinator.start({ target: repo.target }), timeoutMs, 'LIVE_TIMEOUT', 'coordinator start', controller)
    caseReport.transport_calls = transportCalls
    caseReport.requests = transportCalls * REVIEW_LANES.length
    caseReport.model_starts = caseReport.requests
    if (!startedBound.ok) {
      caseReport.failures.push(failureOf(failureError(startedBound)))
      if (startedBound.timeout) cancellation = { reason: 'CASE_TIMEOUT', caseId: spec.caseId, bound_ms: timeoutMs, elapsed_ms: startedBound.latency_ms, bounded: true }
      return { cancelled: cancellation }
    }
    const started = startedBound.value
    caseReport.coordinator.start = { ok: started.ok === true, outcome: started.outcome ?? null, code: started.code ?? null }
    if (!started.ok) {
      caseReport.failures.push({ code: started.code ?? 'START_REJECTED', path: '$.start', message: 'coordinator refused to start the round' })
      return { cancelled: null }
    }
    for (const lane of REVIEW_LANES) await deliverAllPages(input, started.round.lanes[lane].childId)
    const waitedBound = await withBound(coordinator.wait({ roundId: started.round.roundId }), timeoutMs, 'LIVE_TIMEOUT', 'coordinator wait', controller)
    if (!waitedBound.ok) {
      caseReport.failures.push(failureOf(failureError(waitedBound)))
      if (waitedBound.timeout) cancellation = { reason: 'CASE_TIMEOUT', caseId: spec.caseId, bound_ms: timeoutMs, elapsed_ms: waitedBound.latency_ms, bounded: true }
      return { cancelled: cancellation }
    }
    const waited = waitedBound.value
    caseReport.coordinator.wait = { ok: waited.ok === true, outcome: waited.outcome ?? null, code: waited.code ?? null }
    caseReport.coordinator.budget = waited.budget ?? null
    const status = store.status({ workspace: repo.root, target: repo.target })
    const stored = status.record
    const round = stored?.rounds?.find(entry => entry.roundId === started.round.roundId)
    const actualLanes = {}
    for (const lane of REVIEW_LANES) {
      const laneState = round?.lanes?.[lane]
      const result = laneState?.result
      actualLanes[lane] = {
        valid: laneState?.status === 'completed' && isPlainObject(result),
        verdict: result?.verdict ?? null,
        blocker_ids: sorted((result?.blockers ?? []).map(blocker => blocker.id)),
        note_count: Array.isArray(result?.notes) ? result.notes.length : 0,
        summary: typeof result?.summary === 'string' ? result.summary : '',
      }
    }
    caseReport.actual.lanes = actualLanes
    caseReport.coordinator.approval = {
      approved: status.approval?.approved === true,
      reasons: [...(status.approval?.reasons ?? [])],
      roundId: status.approval?.roundId ?? null,
    }
    caseReport.coordinator.receipts = status.approval?.receipts
      ? { practical: pickReceipt(status.approval.receipts.practical), adversarial: pickReceipt(status.approval.receipts.adversarial) }
      : null
    caseReport.coordinator.state = stored?.state ?? null
    caseReport.coordinator.revision = stored?.revision ?? null
    caseReport.complete = actualLanes.practical.valid && actualLanes.adversarial.valid
    if (caseReport.complete) {
      caseReport.arms = caseArms({
        classification: spec.classification,
        spec,
        actualLanes,
        mode: 'live',
        laneLatency: { practical: record?.laneLatency?.practical ?? 0, adversarial: record?.laneLatency?.adversarial ?? 0 },
      })
    } else {
      caseReport.failures.push({ code: 'LIVE_INCOMPLETE', path: '$.wait', message: 'the coordinator did not complete both lanes' })
    }
    return { cancelled: null }
  } catch (error) {
    caseReport.failures.push(failureOf(error))
    return { cancelled: null }
  } finally {
    try { await store.close() } catch { /* the case failure already owns the report */ }
  }
}

function failureError(bound) {
  return bound.error ?? new EvalError('LIVE_TIMEOUT', '$.lane', 'bounded operation failed')
}

/** The HTTP endpoint is only the activation transport. It receives the coordinator
 * prompt and assignment identities, never plan bytes or a key in the body. */
function createHttpStartActivations({ endpoint, key, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch
  let networkAttempts = 0
  const start = async request => {
    if (typeof doFetch !== 'function') fail('CAPABILITY_UNAVAILABLE', '$.transport', 'no fetch implementation is available for live evaluation')
    request.budget.reserve(REVIEW_LANES.length)
    const ctx = request.eval
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const lanes = REVIEW_LANES.map(lane => {
      const childId = request.childIds[lane]
      const runId = 'run-' + ctx.caseId + '-' + lane
      const result = (async () => {
        networkAttempts += 1
        const laneController = new AbortController()
        const relay = () => laneController.abort()
        controller.signal.addEventListener('abort', relay, { once: true })
        let timer
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            laneController.abort()
            reject(new EvalError('LANE_TIMEOUT', '$.lane', 'activation exceeded the ' + timeoutMs + 'ms bound'))
          }, timeoutMs)
        })
        const startedAt = Date.now()
        try {
          const response = await Promise.race([
            doFetch(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
              body: JSON.stringify({
                lane,
                childId,
                runId,
                roundId: ctx.roundId,
                launchId: ctx.launchId,
                planSha256: ctx.planSha,
                route: request.config.lanes[lane],
                prompt: request.prompts[lane],
              }),
              signal: laneController.signal,
            }),
            deadline,
          ])
          if (!response.ok) fail('LANE_ERROR', '$.transport', 'evaluation endpoint returned HTTP ' + response.status)
          const payload = await response.json()
          const result = isPlainObject(payload) && Object.hasOwn(payload, 'result') ? payload.result : payload
          ctx.record?.(lane, {
            model: payload?.model ?? request.config.lanes[lane].model,
            version: payload?.version ?? 'unknown',
            usage: payload?.usage ?? { tokens: null, cost_usd: null },
            latency_ms: payload?.latency_ms ?? (Date.now() - startedAt),
          })
          return result
        } finally {
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', relay)
        }
      })()
      result.catch(() => {})
      return {
        lane,
        childId,
        expectedChildId: childId,
        messageId: 'msg-' + ctx.caseId + '-' + lane,
        preset: 'ulw-plan-review-' + lane,
        runId,
        route: request.config.lanes[lane],
        result,
        dispose: async () => { controller.abort() },
      }
    })
    const handle = {
      provider: 'spawn',
      lanes,
      budget: { reserved: REVIEW_LANES.length, released: 0, consumed: REVIEW_LANES.length },
      runs: {
        snapshot: () => ({
          lanes: lanes.map(lane => ({ lane: lane.lane, childId: lane.childId, runId: lane.runId, started: true, ended: false })),
          unmatchedStarts: [],
          unmatchedEnds: [],
          conflicts: [],
        }),
      },
      releaseObservers: () => { request.signal?.removeEventListener('abort', onAbort) },
      dispose: async () => { controller.abort(); request.signal?.removeEventListener('abort', onAbort) },
    }
    return handle
  }
  Object.defineProperty(start, 'networkAttempts', { get: () => networkAttempts })
  return start
}

async function readExistingReport(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

/** Run an explicitly authorized live evaluation through the real coordinator. */
export async function runLive(options = {}) {
  const started = Date.now()
  const output = resolve(options.outDir ?? join(REPO_ROOT, '.qa-ws', 'review-eval', 'live'))
  const reportPath = join(output, 'live_report.json')
  const authRoots = [output, ...(typeof options.authorizationFile === 'string' ? [dirname(resolve(options.authorizationFile))] : [])]
  let auth
  try {
    auth = await authorizeLive(options)
  } catch (error) {
    const existing = await readExistingReport(reportPath)
    const name = existing === null ? 'live_report.json' : 'live_report.auth_failed.json'
    const report = failureReport({
      mode: 'live',
      error,
      authorization: authFailureSummary(error, options.authorizationFile),
      resume: { detected_partial: existing?.complete === false, reused: false },
    })
    const finalReport = finalizeReport(report, { roots: authRoots })
    const written = await writeReport(output, name, finalReport)
    return { exitCode: EXIT_CODES.live_auth_required, report: finalReport, reportPath: written, outDir: output, cancelled: false }
  }

  const resume = { detected_partial: false, reused: false }
  const previous = await readExistingReport(reportPath)
  if (previous !== null && previous.mode === 'live' && previous.complete === false) resume.detected_partial = true

  const manifestFile = resolve(options.manifestPath ?? DEFAULT_MANIFEST)
  const corpus = resolve(options.corpusDir ?? dirname(manifestFile))
  let loaded
  try {
    loaded = await readManifest(manifestFile)
  } catch (error) {
    const report = failureReport({ mode: 'live', error, authorization: authorizationSummary(auth), resume, status: 'lab_error' })
    const finalReport = finalizeReport(report, { secrets: [auth.key], roots: [output, corpus, REPO_ROOT] })
    const written = await writeReport(output, 'live_report.json', finalReport)
    return { exitCode: EXIT_CODES.live_lab_error, report: finalReport, reportPath: written, outDir: output, cancelled: false }
  }
  const specs = []
  for (const caseId of auth.fixtures) {
    const spec = loaded.manifest.cases.find(entry => entry.caseId === caseId)
    if (spec === undefined) {
      const error = new EvalError('UNKNOWN_FIXTURE', '$.fixtures', 'authorized fixture ' + caseId + ' is not in the truth corpus')
      const report = failureReport({ mode: 'live', error, sourceHash: loaded.sourceHash, corpus: corpusReport(loaded), authorization: authorizationSummary(auth), resume, status: 'lab_error' })
      const finalReport = finalizeReport(report, { secrets: [auth.key], roots: [output, corpus, REPO_ROOT] })
      const written = await writeReport(output, 'live_report.json', finalReport)
      return { exitCode: EXIT_CODES.live_lab_error, report: finalReport, reportPath: written, outDir: output, cancelled: false }
    }
    specs.push(spec)
  }

  await fs.mkdir(output, { recursive: true })
  const scratchRoot = await fs.mkdtemp(join(output, 'scratch-'))
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60000
  const sentinel = typeof options.sentinel === 'string' && options.sentinel !== ''
    ? options.sentinel
    : 'ULW_SENTINEL_' + createHash('sha256').update(String(Math.random()) + String(started)).digest('hex').slice(0, 32)
  const mask = [auth.key, sentinel]
  const side = {
    tokens: 0,
    cost: 0,
    tokensKnown: true,
    costKnown: true,
    latency: 0,
    models: { practical: null, adversarial: null },
  }
  const record = (lane, meta) => {
    const usage = normalizeUsage(meta?.usage)
    if (usage.tokens === null) side.tokensKnown = false
    else side.tokens += usage.tokens
    if (usage.cost_usd === null) side.costKnown = false
    else side.cost += usage.cost_usd
    if (typeof meta?.latency_ms === 'number' && Number.isFinite(meta.latency_ms)) side.latency += meta.latency_ms
    side.models[lane] = { model: meta?.model ?? null, version: meta?.version ?? null }
  }
  const startActivations = typeof options.startActivations === 'function'
    ? options.startActivations
    : createHttpStartActivations({ endpoint: auth.endpoint, key: auth.key, timeoutMs, fetchImpl: options.fetchImpl })
  const liveCases = []
  const labErrors = []
  let calls = 0
  let transportCalls = 0
  let status = 'complete'
  let budgetExhausted = false
  let cancelled = null
  let workspaces = 0
  let scratchRemoved = true
  try {
    outer: for (const spec of specs) {
      const remaining = auth.maxCalls - calls
      if (remaining < REVIEW_LANES.length) {
        budgetExhausted = true
        status = 'budget_exhausted'
        break
      }
      const caseReport = {
        caseId: spec.caseId,
        classification: spec.classification,
        defect: spec.defect,
        structural: spec.structural,
        plan: planTargetOf(spec),
        complete: false,
        expected: { structural: { valid: spec.expected.lint.valid, errors: expectedErrorTuples(spec.expected.lint), warnings: expectedWarningTuples(spec.expected.lint) } },
        actual: { planSha256: null, structural: { valid: null, errors: [], warnings: [], matches_expected: false }, lanes: {} },
        coordinator: emptyCoordinatorView(),
        failures: [],
        requests: 0,
        transport_calls: 0,
        arms: null,
      }
      liveCases.push(caseReport)
      let repo
      try {
        repo = await materializeCase(spec, join(scratchRoot, spec.caseId), corpus)
        workspaces += 1
      } catch (error) {
        caseReport.failures.push(failureOf(error))
        labErrors.push({ code: 'MATERIALIZE_FAILED', caseId: spec.caseId, message: failureOf(error).message })
        status = 'lab_error'
        break
      }
      const structural = structuralOf(spec, repo)
      caseReport.expected.structural = structural.expected
      caseReport.actual = { planSha256: repo.planSha, structural: structural.actual, lanes: {} }
      const outcome = await runCoordinatorCase({
        spec,
        repo,
        caseReport,
        auth,
        remainingCalls: remaining,
        timeoutMs,
        startActivations,
        record,
        workspaceLint: structural.lint,
      })
      transportCalls += caseReport.transport_calls
      calls += caseReport.requests
      if (outcome.cancelled !== null) {
        cancelled = { ...outcome.cancelled, elapsed_ms: Date.now() - started }
        status = 'cancelled'
        break
      }
      const hits = await scanForSentinel(repo.root, sentinel)
      if (hits.length > 0) {
        labErrors.push({ code: 'LIVE_SENTINEL_LEAK', caseId: spec.caseId, files: hits })
        status = 'lab_error'
        break
      }
      if (side.tokensKnown && side.tokens > auth.maxTokens) {
        budgetExhausted = true
        status = 'budget_exhausted'
        break
      }
      if (!caseReport.complete && status === 'complete') {
        status = 'incomplete'
        break
      }
    }
  } catch (error) {
    labErrors.push({ code: 'RUNNER_ERROR', message: messageOf(error) })
    status = 'lab_error'
  } finally {
    try {
      await fs.rm(scratchRoot, { recursive: true, force: true })
    } catch {
      // Reported below.
    }
    scratchRemoved = !existsSync(scratchRoot)
  }
  if (!scratchRemoved) {
    labErrors.push({ code: 'CLEANUP_FAILED', message: 'scratch workspace was not removed' })
    status = 'lab_error'
  }
  const completedCases = liveCases.filter(entry => entry.complete === true)
  const complete = status === 'complete' && liveCases.length === specs.length && completedCases.length === specs.length && labErrors.length === 0 && scratchRemoved
  const metrics = applyGroupMetrics(metricsFor(completedCases, 'live'))
  const usage = {
    tokens: side.tokensKnown && calls > 0 ? side.tokens : 'unknown',
    cost_usd: side.costKnown && calls > 0 ? side.cost : 'unknown',
    latency_ms: calls > 0 ? side.latency : 0,
  }
  const approvals = {
    approved: completedCases.filter(entry => entry.coordinator.approval.approved === true).length,
    rejected: completedCases.filter(entry => entry.coordinator.approval.approved !== true).length,
  }
  const liveQuality = complete
    ? { status: 'measured', measured_cases: completedCases.length, metrics, approvals }
    : 'not_measured'
  const firstFailure = liveCases.flatMap(entry => entry.failures)[0] ?? null
  const networkAttempts = typeof startActivations.networkAttempts === 'number' ? startActivations.networkAttempts : 0
  const report = {
    schema: EVAL_SCHEMA,
    mode: 'live',
    status: status,
    complete,
    mechanism_passed: complete,
    live_quality: liveQuality,
    corpus: corpusReport(loaded),
    source: {
      sourceHash: loaded.sourceHash,
      route: { practical: auth.routes.practical, adversarial: auth.routes.adversarial },
      seed: loaded.manifest.corpus,
      mode: 'live',
      cost: usage.cost_usd,
    },
    mechanism: {
      coordinator: 'lib/review-coordinator.js',
      preflight: 'lib/review-transport.js',
      store: 'lib/review-store.js',
      input: 'lib/review-input.js',
      lint: 'lib/review-lint.js',
    },
    error: labErrors[0] ?? firstFailure,
    authorization: authorizationSummary(auth),
    requests: calls,
    transport_calls: transportCalls,
    model_starts: calls,
    network_attempts: networkAttempts,
    cases: liveCases,
    structural: structuralSummary(liveCases),
    groups: grouping(metricsFor(liveCases, 'live')),
    metrics,
    usage,
    budget: {
      max_calls: auth.maxCalls,
      max_tokens: auth.maxTokens,
      calls,
      tokens: side.tokensKnown ? side.tokens : 'unknown',
      exhausted: budgetExhausted,
    },
    cancellation: cancelled,
    lab_errors: labErrors,
    cleanup: { scratch_created: true, workspaces, scratch_removed: scratchRemoved },
    resume,
    models: side.models,
    approvals,
  }
  const finalReport = finalizeReport(report, { secrets: mask, roots: [output, scratchRoot, corpus, manifestFile, REPO_ROOT] })
  const written = await writeReport(output, 'live_report.json', finalReport)
  const exitCode = cancelled !== null
    ? EXIT_CODES.live_cancelled
    : budgetExhausted
      ? EXIT_CODES.live_budget_exhausted
      : complete
        ? EXIT_CODES.ok
        : EXIT_CODES.live_lab_error
  return { exitCode, report: finalReport, reportPath: written, outDir: output, cancelled: cancelled !== null }
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = [
  'usage: node qa/review-eval.mjs [--mode replay|live] [--out <dir>]',
  '',
  '  --mode replay      deterministic offline truth-manifest replay (default)',
  '  --mode live        explicitly authorized live evaluation; requires',
  '                     --authorize-live (or --confirm-live), --authorization <budget.json>,',
  '                     a configured key in the budget keyEnv variable and paid:true',
  '  --manifest <file>  truth manifest (default: test/fixtures/review/manifest.json)',
  '  --out <dir>        report directory (default: .qa-ws/review-eval/<mode>)',
  '  --timeout-ms <n>   per-lane live bound (default: 60000)',
  '  --help             print this help',
  '',
  'replay writes replay_report.json and always sets live_quality=not_measured.',
  'exit codes: 0 pass; 2 replay failure; 4 live authorization required;',
  '            5 live cancelled; 6 live lab_error; 7 live budget exhausted; 64 usage',
].join('\n')

function parseArgs(argv) {
  const args = { mode: 'replay', out: null, manifest: DEFAULT_MANIFEST, authorization: null, authorizeLive: false, timeoutMs: 60000, help: false }
  const valueOf = (index, flag) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail('USAGE', flag, 'missing value for ' + flag + '\n' + USAGE)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--mode') { args.mode = valueOf(index, '--mode'); index += 1 }
    else if (arg.startsWith('--mode=')) args.mode = arg.slice('--mode='.length)
    else if (arg === '--out') { args.out = valueOf(index, '--out'); index += 1 }
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length)
    else if (arg === '--manifest') { args.manifest = valueOf(index, '--manifest'); index += 1 }
    else if (arg.startsWith('--manifest=')) args.manifest = arg.slice('--manifest='.length)
    else if (arg === '--authorization') { args.authorization = valueOf(index, '--authorization'); index += 1 }
    else if (arg.startsWith('--authorization=')) args.authorization = arg.slice('--authorization='.length)
    else if (arg === '--authorize-live' || arg === '--confirm-live') args.authorizeLive = true
    else if (arg === '--timeout-ms') { args.timeoutMs = Number(valueOf(index, '--timeout-ms')); index += 1 }
    else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Number(arg.slice('--timeout-ms='.length))
    else fail('USAGE', arg, 'unknown flag: ' + arg + '\n' + USAGE)
  }
  if (!EVAL_MODES.includes(args.mode)) fail('USAGE', '$.mode', 'mode must be replay or live')
  if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0) fail('USAGE', '$.timeoutMs', 'timeout must be a positive integer')
  return args
}

function armLine(label, arm) {
  return label + ' blockers tp/fp/fn=' + arm.blockers.tp + '/' + arm.blockers.fp + '/' + arm.blockers.fn
    + ' precision=' + (arm.blockers.precision === null ? 'n/a' : arm.blockers.precision)
    + ' recall=' + (arm.blockers.recall === null ? 'n/a' : arm.blockers.recall)
    + ' cases tp/fp/fn=' + arm.cases.tp + '/' + arm.cases.fp + '/' + arm.cases.fn
    + ' clean_false_rejects=' + arm.clean_false_rejects
    + ' disagreements=' + arm.disagreements
    + ' calls=' + arm.calls
    + ' model_starts=' + arm.model_starts
}
function shownPath(file) {
  const rel = relative(process.cwd(), file)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? file : rel
}
function printReplay(result) {
  const report = result.report
  process.stdout.write([
    'mode=replay',
    'cases=' + report.cases.length + ' passed=' + report.cases.filter(entry => entry.passed).length + ' seedCases=' + report.corpus.seedCases,
    'structural=matched:' + report.structural.matched + '/mismatched:' + report.structural.mismatched,
    armLine('single_inline', report.metrics.overall.single_inline),
    armLine('dual', report.metrics.overall.dual),
    'live_quality=not_measured (replay validates only the evaluator; no model was called)',
    'mechanism_passed=' + report.mechanism_passed,
    'report=' + shownPath(result.reportPath),
    '',
  ].join('\n'))
}
function printLive(result) {
  const report = result.report
  if (report.authorization?.granted === false) {
    const code = report.authorization.code ?? 'LIVE_AUTH_REQUIRED'
    process.stderr.write(code + ': ' + report.authorization.message + '\n')
    process.stderr.write('live_quality=not_measured requests=0 model_starts=0\n')
    return
  }
  const quality = report.live_quality === 'not_measured' ? 'not_measured' : report.live_quality.status + '(' + report.live_quality.measured_cases + ')'
  process.stdout.write([
    'mode=live',
    'status=' + report.status + ' complete=' + report.complete + ' mechanism_passed=' + report.mechanism_passed,
    'cases=' + report.cases.length + ' measured=' + report.cases.filter(entry => entry.complete).length,
    armLine('single_inline', report.metrics.overall.single_inline),
    armLine('dual', report.metrics.overall.dual),
    'requests=' + report.requests + ' model_starts=' + report.model_starts + ' tokens=' + report.usage.tokens + ' cost_usd=' + report.usage.cost_usd,
    'live_quality=' + quality,
    'report=' + shownPath(result.reportPath),
    '',
  ].join('\n'))
  for (const labError of report.lab_errors) process.stderr.write('LAB_ERROR ' + labError.code + ': ' + (labError.message ?? '') + '\n')
  if (report.cancellation !== null) process.stderr.write('CANCELLED: ' + report.cancellation.reason + ' bound_ms=' + report.cancellation.bound_ms + '\n')
}
export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(messageOf(error) + '\n')
    return EXIT_CODES.usage
  }
  if (args.help) {
    process.stdout.write(USAGE + '\n')
    return EXIT_CODES.ok
  }
  if (args.mode === 'replay') {
    const result = await runReplay({ manifestPath: args.manifest, outDir: args.out })
    printReplay(result)
    if (result.exitCode !== EXIT_CODES.ok) process.stderr.write('REPLAY_FAILED: ' + (result.report.error?.code ?? 'CASE_FAILURE') + '\n')
    return result.exitCode
  }
  const result = await runLive({
    manifestPath: args.manifest,
    outDir: args.out,
    authorizationFile: args.authorization,
    authorizeLive: args.authorizeLive,
    timeoutMs: args.timeoutMs,
  })
  printLive(result)
  return result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write('review-eval: ' + messageOf(error) + '\n')
    process.exitCode = EXIT_CODES.replay_failed
  }
}
