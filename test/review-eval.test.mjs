/**
 * Quality-evaluation runner: honest replay, explicitly authorized live.
 *
 * These tests pin the boundary that row 16 exists for:
 *   - replay is the default, fully offline, deterministic mode. It consumes the
 *     row-6 truth manifest, re-materializes every fixture, compares the structural
 *     lint truth and the protocol-valid semantic blockers, and labels
 *     live_quality=not_measured because no model was called;
 *   - live mode is never reachable by accident. It requires an explicit
 *     --authorize-live/--confirm-live flag, an operator budget file, a configured
 *     key and an explicitly accepted paid quota; otherwise it exits nonzero with
 *     LIVE_AUTH_REQUIRED and zero requests/model starts;
 *   - a sentinel leaking into a live scratch workspace is a lab_error, not a
 *     measured quality result; cancellation is bounded and scratch workspaces are
 *     removed even when the transport ignores the abort signal;
 *   - metrics are computed from actual lane results, never copied from the truth
 *     manifest, so a forged OKAY or a fabricated blocker changes TP/FP/FN.
 *
 * No test starts a model or touches the network. The only child processes are the
 * runner CLI itself (replay and unauthorized live), plus one external fetch guard
 * module that proves a rejected live run made no network attempt.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  EXIT_CODES,
  computeConfusion,
  evaluateReplayCase,
  loadManifest,
  runLive,
  runReplay,
  sha256,
  truthLaneResult,
} from '../qa/review-eval.mjs'
import { REVIEW_LANES } from '../lib/review-protocol.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'qa', 'review-eval.mjs')
const MANIFEST_PATH = join(ROOT, 'test', 'fixtures', 'review', 'manifest.json')
const CORPUS_DIR = join(ROOT, 'test', 'fixtures', 'review')
const KEY_ENV = 'DSH_REVIEW_EVAL_API_KEY'
const API_KEY = 'sk-live-eval-test-' + 'a'.repeat(24)
const SENTINEL = 'ULW_SENTINEL_' + 'b'.repeat(32)

const manifest = await loadManifest(MANIFEST_PATH)
const specById = new Map(manifest.cases.map(spec => [spec.caseId, spec]))

async function makeTemp(prefix) {
  return fs.mkdtemp(join(tmpdir(), prefix))
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function writeBudget(dir, overrides = {}) {
  const budget = {
    version: 1,
    callBudget: 4,
    maxTokens: 100000,
    paid: true,
    fixtures: ['clean-new-file'],
    endpoint: 'http://127.0.0.1:9/review-eval',
    keyEnv: KEY_ENV,
    lanes: {
      practical: { provider: 'eval', model: 'eval-practical-1', maxTokens: 1000 },
      adversarial: { provider: 'eval', model: 'eval-adversarial-1', maxTokens: 1000 },
    },
    ...overrides,
  }
  const file = join(dir, 'budget.json')
  await fs.writeFile(file, JSON.stringify(budget, null, 2), 'utf8')
  return file
}

/**
 * A scripted native activation transport for the real coordinator. It reserves
 * the coordinator's budget, emits both pre-bound lane handles with synthetic run
 * identities, and resolves valid protocol results bound to the runner's round and
 * launch. No model or network is involved.
 */
function scriptedActivations(options = {}) {
  const { summaryFor, writeSentinel = false, hangCase = null, resultFor } = options
  const calls = []
  async function startActivations(request) {
    const ctx = request.eval
    assert.ok(ctx && ctx.caseId, 'the runner must attach one eval context')
    calls.push({ caseId: ctx.caseId, childIds: { ...request.childIds } })
    request.budget.reserve(2)
    if (writeSentinel) await fs.writeFile(join(ctx.workspace, 'leaked-sentinel.txt'), SENTINEL, 'utf8')
    const spec = specById.get(ctx.caseId)
    assert.ok(spec, 'unknown fixture ' + ctx.caseId)
    const lanes = REVIEW_LANES.map(lane => {
      const childId = request.childIds[lane]
      const runId = 'run-' + ctx.caseId + '-' + lane
      let resultPromise
      if (ctx.caseId === hangCase) {
        resultPromise = new Promise(() => {})
      } else {
        const base = typeof resultFor === 'function' ? resultFor({ spec, lane, ctx }) : truthLaneResult(spec, lane, ctx.planSha)
        const result = { ...base, lane, roundId: ctx.roundId, launchId: ctx.launchId, planSha256: ctx.planSha }
        result.summary = summaryFor === undefined ? result.summary : summaryFor(result, ctx)
        ctx.record(lane, {
          model: 'fake-' + lane,
          version: 'test-1',
          usage: { tokens: 10, cost_usd: 0.001 },
          latency_ms: 1,
        })
        resultPromise = Promise.resolve(result)
      }
      resultPromise.catch(() => {})
      return {
        lane,
        childId,
        expectedChildId: childId,
        messageId: 'msg-' + ctx.caseId + '-' + lane,
        preset: 'ulw-plan-review-' + lane,
        runId,
        route: request.config.lanes[lane],
        result: resultPromise,
        dispose: async () => {},
      }
    })
    return {
      provider: 'spawn',
      lanes,
      budget: { reserved: 2, released: 0, consumed: 2 },
      runs: {
        snapshot: () => ({
          lanes: lanes.map(lane => ({ lane: lane.lane, childId: lane.childId, runId: lane.runId, started: true, ended: false })),
          unmatchedStarts: [],
          unmatchedEnds: [],
          conflicts: [],
        }),
      },
      releaseObservers: () => {},
      dispose: async () => {},
    }
  }
  return { startActivations, calls }
}

function assertReportDigest(report) {
  const { report_sha256, ...withoutDigest } = report
  assert.match(report_sha256, /^[a-f0-9]{64}$/)
  assert.equal(report_sha256, sha256(JSON.stringify(withoutDigest)))
}

function assertNoAbsolutePaths(report, ...needles) {
  const text = JSON.stringify(report)
  for (const needle of needles) assert.ok(!text.includes(needle), 'report leaked path ' + needle)
  assert.ok(!text.includes('/home/'), 'report leaked an absolute home path')
  assert.ok(!text.includes('/tmp/'), 'report leaked an absolute temporary path')
  assert.ok(!/[A-Za-z]:\\\\/.test(text), 'report leaked a Windows absolute path')
}

function childEnv(extra = {}, withKey = false) {
  const env = { ...process.env, ...extra }
  if (!withKey) delete env[KEY_ENV]
  return env
}

/**
 * Run the CLI with a temporary ESM guard that replaces global fetch. The loaded
 * marker proves the guard was actually imported; the probe marker can only exist
 * if the runner attempted a network call.
 */
async function guardedCli(args, extraEnv = {}) {
  const dir = await makeTemp('ulw-eval-guard-')
  const guard = join(dir, 'guard.mjs')
  const loaded = join(dir, 'loaded.marker')
  const probe = join(dir, 'fetch.marker')
  await fs.writeFile(guard, [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(' + JSON.stringify(loaded) + ", 'loaded')",
    'globalThis.fetch = async () => {',
    '  writeFileSync(' + JSON.stringify(probe) + ", 'FETCH')",
    "  throw new Error('network disabled by the evaluation test guard')",
    '}',
    '',
  ].join('\n'), 'utf8')
  const nodeOptions = [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(guard).href].filter(Boolean).join(' ')
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: childEnv({ ...extraEnv, NODE_OPTIONS: nodeOptions }),
  })
  return { result, loaded: existsSync(loaded), probe: existsSync(probe), dir }
}

test('replay CLI consumes the row-6 truth manifest, writes replay_report.json and measures no model', async () => {
  const out = await makeTemp('ulw-eval-replay-cli-')
  try {
    const run = spawnSync(process.execPath, [CLI, '--mode', 'replay', '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
    })
    assert.equal(run.status, EXIT_CODES.ok, 'runner failed: ' + run.stderr + run.stdout)
    assert.deepEqual((await fs.readdir(out)).sort(), ['replay_report.json'], 'replay left a scratch workspace behind')
    const report = await readJson(join(out, 'replay_report.json'))
    const manifestHash = sha256(await fs.readFile(MANIFEST_PATH, 'utf8'))
    assert.equal(report.schema, 'ulw-review-eval/v1')
    assert.equal(report.mode, 'replay')
    assert.equal(report.source.mode, 'replay')
    assert.equal(report.source.cost, 'unknown')
    assert.equal(report.source.sourceHash, manifestHash)
    assert.equal(report.corpus.sourceHash, manifestHash)
    assert.equal(report.corpus.seedCases, 12)
    assert.equal(report.live_quality, 'not_measured')
    assert.equal(report.mechanism_passed, true)
    assert.equal(report.requests, 0)
    assert.equal(report.model_starts, 0)
    assert.equal(report.cases.length, 12)
    assert.equal(report.structural.matched, 12)
    assert.equal(report.structural.mismatched, 0)
    assert.deepEqual(report.groups.structural.case_ids, ['bad-duplicate-id', 'bad-missing-reference'])
    assert.equal(report.groups.semantic.case_ids.length, 10)
    for (const entry of report.cases) {
      assert.equal(entry.passed, true, entry.caseId + ': ' + JSON.stringify(entry.failures))
      assert.equal(entry.expected.planSha256, entry.actual.planSha256, entry.caseId)
      assert.equal(entry.actual.structural.matches_expected, true, entry.caseId)
    }
    const fake = report.cases.find(entry => entry.caseId === 'bad-fake-okay')
    assert.deepEqual(fake.expected.blockers.adversarial, ['blk.adversarial.ideal_state_gap.GAP-2'])
    assert.deepEqual(fake.expected.blockers.practical, [])
    assert.equal(fake.actual.lanes.adversarial.verdict, 'REJECT')
    assert.equal(fake.actual.lanes.practical.verdict, 'OKAY')
    assert.equal(fake.arms.single_inline.cases.fn, 1)
    assert.equal(fake.arms.dual.cases.tp, 1)
    assert.equal(report.metrics.overall.dual.blockers.tp, 8)
    assert.equal(report.metrics.overall.dual.blockers.fp, 0)
    assert.equal(report.metrics.overall.dual.blockers.fn, 0)
    assert.equal(report.metrics.overall.dual.blockers.precision, 1)
    assert.equal(report.metrics.overall.dual.blockers.recall, 1)
    assert.equal(report.metrics.overall.single_inline.blockers.tp, 4)
    assert.equal(report.metrics.overall.single_inline.blockers.fn, 4)
    assert.equal(report.metrics.overall.dual.cases.tp, 8)
    assert.equal(report.metrics.overall.single_inline.cases.tp, 4)
    assert.equal(report.metrics.overall.dual.clean_false_rejects, 0)
    assert.equal(report.metrics.overall.dual.disagreements, 8)
    assert.equal(report.metrics.overall.single_inline.calls, 0)
    assert.equal(report.metrics.overall.dual.calls, 0)
    assert.equal(report.metrics.overall.dual.model_starts, 0)
    assert.equal(report.metrics.overall.dual.latency_ms, null)
    assert.equal(report.cleanup.scratch_removed, true)
    assert.equal(report.cleanup.workspaces, 12)
    assert.ok(!JSON.stringify(report).includes(out), 'report leaked an absolute scratch/output path')
    const { report_sha256, ...withoutDigest } = report
    assert.match(report_sha256, /^[a-f0-9]{64}$/)
    assert.equal(report_sha256, sha256(JSON.stringify(withoutDigest)))
  } finally {
    await fs.rm(out, { recursive: true, force: true })
  }
})

test('known metric accounting matches independent TP=3/FP=1/FN=2 arithmetic', () => {
  const scored = computeConfusion(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'x'])
  assert.deepEqual([scored.tp, scored.fp, scored.fn], [3, 1, 2])
  assert.equal(scored.precision, 3 / 4)
  assert.equal(scored.recall, 3 / 5)
  assert.equal(scored.f1, (2 * (3 / 4) * (3 / 5)) / ((3 / 4) + (3 / 5)))
  const empty = computeConfusion([], [])
  assert.deepEqual([empty.tp, empty.fp, empty.fn], [0, 0, 0])
  assert.equal(empty.precision, null)
  assert.equal(empty.recall, null)
  const missed = computeConfusion(['a'], [])
  assert.equal(missed.tp, 0)
  assert.equal(missed.fn, 1)
  assert.equal(missed.recall, 0)
})

test('unauthorized live exits nonzero, reports not_measured and never attempts the network', async () => {
  const env = childEnv({}, false)
  const cases = []
  const runOne = async (label, args, budgetOverrides = null, withKey = false, guard = false) => {
    const dir = await makeTemp('ulw-eval-live-gate-')
    const out = join(dir, 'out')
    const fullArgs = ['--mode', 'live', '--out', out, ...args]
    let file = null
    if (budgetOverrides !== null) {
      file = await writeBudget(dir, budgetOverrides)
      fullArgs.push('--authorization', file)
    }
    const invocation = guard
      ? await guardedCli(fullArgs, withKey ? { [KEY_ENV]: API_KEY } : {})
      : { result: spawnSync(process.execPath, [CLI, ...fullArgs], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: withKey ? childEnv({ [KEY_ENV]: API_KEY }) : env }) }
    cases.push({ label, dir, out, invocation })
    return invocation
  }

  await runOne('no explicit flag, no budget', [])
  await runOne('explicit flag but no budget file', ['--authorize-live'])
  await runOne('budget file but no explicit flag', [], { callBudget: 2, fixtures: ['clean-new-file'] })
  const noKey = await runOne('explicit authorization and paid budget but no configured key', ['--authorize-live'], { callBudget: 2, fixtures: ['clean-new-file'] }, false, true)
  await runOne('paid quota not accepted', ['--authorize-live'], { callBudget: 2, fixtures: ['clean-new-file'], paid: false }, true)

  assert.equal(noKey.loaded, true, 'external fetch guard was not loaded')
  assert.equal(noKey.probe, false, 'unauthorized live attempted a network call')
  for (const entry of cases) {
    const { result } = entry.invocation
    assert.equal(result.status, EXIT_CODES.live_auth_required, entry.label + ': ' + result.stderr + result.stdout)
    assert.match(result.stderr, /LIVE_AUTH_REQUIRED|INVALID_AUTHORIZATION/, entry.label + ': ' + result.stderr)
    const report = await readJson(join(entry.out, 'live_report.json'))
    assert.equal(report.mode, 'live', entry.label)
    assert.equal(report.live_quality, 'not_measured', entry.label)
    assert.equal(report.mechanism_passed, false, entry.label)
    assert.equal(report.complete, false, entry.label)
    assert.equal(report.requests, 0, entry.label)
    assert.equal(report.model_starts, 0, entry.label)
    assert.equal(report.network_attempts, 0, entry.label)
    assert.equal(report.authorization.granted, false, entry.label)
    assert.ok(['LIVE_AUTH_REQUIRED', 'INVALID_AUTHORIZATION'].includes(report.authorization.code), entry.label)
    assert.equal(report.cleanup.scratch_removed, true, entry.label + ': unauthorized run still cleans up')
    assertReportDigest(report)
    assertNoAbsolutePaths(report, entry.dir)
    assert.deepEqual((await fs.readdir(entry.out)).sort(), ['live_report.json'], entry.label)
  }
  for (const entry of cases) await fs.rm(entry.dir, { recursive: true, force: true })
})

test('live mode is the coordinator pipeline: a lint-invalid fixture is refused before transport', async () => {
  const dir = await makeTemp('ulw-eval-live-lint-refused-')
  const out = join(dir, 'out')
  try {
    const budget = await writeBudget(dir, { callBudget: 2, fixtures: ['bad-missing-reference'] })
    const scripted = scriptedActivations()
    const result = await runLive({
      manifestPath: MANIFEST_PATH,
      corpusDir: CORPUS_DIR,
      outDir: out,
      authorizationFile: budget,
      authorizeLive: true,
      env: { [KEY_ENV]: API_KEY },
      timeoutMs: 2000,
      startActivations: scripted.startActivations,
    })
    assert.equal(result.exitCode, EXIT_CODES.live_lab_error)
    assert.equal(scripted.calls.length, 0, 'lint-invalid fixture must never invoke the activation transport')
    assert.equal(result.report.complete, false)
    assert.equal(result.report.mechanism_passed, false)
    assert.equal(result.report.live_quality, 'not_measured')
    assert.equal(result.report.requests, 0)
    assert.equal(result.report.model_starts, 0)
    assert.equal(result.report.transport_calls, 0)
    assert.equal(result.report.mechanism.coordinator, 'lib/review-coordinator.js')
    const entry = result.report.cases.find(item => item.caseId === 'bad-missing-reference')
    assert.equal(entry.complete, false)
    assert.equal(entry.coordinator.start.code, 'LINT_FAILED')
    assert.equal(entry.coordinator.start.ok, false)
    assert.equal(entry.expected.structural.valid, false)
    assert.equal(entry.actual.structural.valid, false)
    assert.equal(entry.actual.structural.matches_expected, true)
    assert.equal(result.report.structural.expected_invalid, 1)
    assert.equal(result.report.structural.actual_invalid, 1)
    assert.equal(result.report.structural.matched, 1)
    assert.equal(result.report.structural.mismatched, 0)
    assert.ok(entry.failures.some(failure => failure.code === 'LINT_FAILED'))
    assertReportDigest(result.report)
    assertNoAbsolutePaths(result.report, dir, out)
    assert.deepEqual((await fs.readdir(out)).sort(), ['live_report.json'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('valid live fixture drives coordinator require/start/wait with coordinator receipts and approval', async () => {
  const dir = await makeTemp('ulw-eval-live-coordinator-')
  const out = join(dir, 'out')
  try {
    const budget = await writeBudget(dir, { callBudget: 2, fixtures: ['clean-new-file'] })
    const scripted = scriptedActivations({ summaryFor: () => 'reviewer used key ' + API_KEY + ' for this run' })
    const result = await runLive({
      manifestPath: MANIFEST_PATH,
      corpusDir: CORPUS_DIR,
      outDir: out,
      authorizationFile: budget,
      authorizeLive: true,
      env: { [KEY_ENV]: API_KEY },
      timeoutMs: 2000,
      startActivations: scripted.startActivations,
    })
    assert.equal(result.exitCode, EXIT_CODES.ok, JSON.stringify(result.report.lab_errors))
    assert.equal(result.report.complete, true)
    assert.equal(result.report.mechanism_passed, true)
    assert.equal(result.report.live_quality.status, 'measured')
    assert.equal(result.report.live_quality.measured_cases, 1)
    assert.equal(scripted.calls.length, 1)
    assert.equal(result.report.transport_calls, 1)
    assert.equal(result.report.requests, 2)
    assert.equal(result.report.model_starts, 2)
    assert.equal(result.report.mechanism.coordinator, 'lib/review-coordinator.js')
    assert.equal(result.report.mechanism.preflight, 'lib/review-transport.js')
    assert.equal(result.report.mechanism.store, 'lib/review-store.js')
    const entry = result.report.cases.find(item => item.caseId === 'clean-new-file')
    assert.equal(entry.complete, true)
    assert.equal(entry.coordinator.require.outcome, 'required')
    assert.equal(entry.coordinator.start.outcome, 'started')
    assert.equal(entry.coordinator.wait.outcome, 'approved')
    assert.equal(entry.coordinator.approval.approved, true)
    assert.equal(entry.coordinator.state, 'approved')
    assert.match(entry.coordinator.receipts.practical.resultSha256, /^[a-f0-9]{64}$/)
    assert.equal(entry.coordinator.receipts.practical.verdict, 'OKAY')
    assert.equal(entry.coordinator.receipts.adversarial.verdict, 'OKAY')
    assert.equal(entry.actual.structural.valid, true)
    assert.equal(entry.actual.structural.matches_expected, true)
    assert.equal(result.report.structural.expected_invalid, 0)
    assert.equal(result.report.structural.actual_invalid, 0)
    assert.equal(result.report.structural.matched, 1)
    assert.equal(result.report.structural.mismatched, 0)
    assert.equal(result.report.metrics.overall.dual.calls, 2)
    assert.equal(result.report.metrics.overall.dual.clean_false_rejects, 0)
    assert.equal(result.report.usage.tokens, 20)
    assert.equal(result.report.usage.cost_usd, 0.002)
    assert.equal(typeof result.report.usage.latency_ms, 'number')
    assert.equal(result.report.models.practical.model, 'fake-practical')
    assert.equal(result.report.models.practical.version, 'test-1')
    assert.equal(result.report.cleanup.scratch_removed, true)
    assert.deepEqual((await fs.readdir(out)).sort(), ['live_report.json'])
    const bytes = await fs.readFile(join(out, 'live_report.json'), 'utf8')
    assert.ok(!bytes.includes(API_KEY), 'live report leaked the configured key')
    assert.match(bytes, /\[REDACTED\]/, 'secret output was not masked')
    assertReportDigest(result.report)
    assertNoAbsolutePaths(result.report, dir, out)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('live sentinel in a workspace is a lab_error, never a measured score', async () => {
  const dir = await makeTemp('ulw-eval-live-sentinel-')
  const out = join(dir, 'out')
  try {
    const budget = await writeBudget(dir, { callBudget: 2, fixtures: ['bad-fake-okay'] })
    const scripted = scriptedActivations({ writeSentinel: true })
    const result = await runLive({
      manifestPath: MANIFEST_PATH,
      corpusDir: CORPUS_DIR,
      outDir: out,
      authorizationFile: budget,
      authorizeLive: true,
      env: { [KEY_ENV]: API_KEY },
      sentinel: SENTINEL,
      timeoutMs: 2000,
      startActivations: scripted.startActivations,
    })
    assert.equal(result.exitCode, EXIT_CODES.live_lab_error)
    assert.equal(result.report.complete, false)
    assert.equal(result.report.mechanism_passed, false)
    assert.equal(result.report.live_quality, 'not_measured')
    assert.equal(result.report.requests, 2)
    assert.equal(result.report.transport_calls, 1)
    assert.equal(result.report.lab_errors.length, 1)
    assert.equal(result.report.lab_errors[0].code, 'LIVE_SENTINEL_LEAK')
    assert.equal(result.report.lab_errors[0].caseId, 'bad-fake-okay')
    assert.equal(result.report.cleanup.scratch_removed, true)
    assert.deepEqual((await fs.readdir(out)).sort(), ['live_report.json'])
    const bytes = await fs.readFile(join(out, 'live_report.json'), 'utf8')
    assert.ok(!bytes.includes(SENTINEL), 'report leaked the sentinel value')
    assertReportDigest(result.report)
    assertNoAbsolutePaths(result.report, dir, out)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('cancel_resume: hung live wait is bounded, partial data survives and the resume is fresh', async () => {
  const dir = await makeTemp('ulw-eval-live-cancel-')
  const out = join(dir, 'out')
  try {
    const budget = await writeBudget(dir, { callBudget: 4, fixtures: ['clean-new-file', 'bad-fake-okay'] })
    const options = {
      manifestPath: MANIFEST_PATH,
      corpusDir: CORPUS_DIR,
      outDir: out,
      authorizationFile: budget,
      authorizeLive: true,
      env: { [KEY_ENV]: API_KEY },
      timeoutMs: 40,
    }
    const started = Date.now()
    const cancelled = await runLive({
      ...options,
      startActivations: scriptedActivations({ hangCase: 'bad-fake-okay' }).startActivations,
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, 'hung live wait was not cancelled within the bound: ' + elapsed + 'ms')
    assert.equal(cancelled.exitCode, EXIT_CODES.live_cancelled)
    assert.equal(cancelled.report.complete, false)
    assert.equal(cancelled.report.status, 'cancelled')
    assert.equal(cancelled.report.live_quality, 'not_measured')
    assert.equal(cancelled.report.cancellation.bounded, true)
    assert.equal(cancelled.report.cancellation.bound_ms, 40)
    assert.equal(cancelled.report.cleanup.scratch_removed, true)
    assert.deepEqual((await fs.readdir(out)).sort(), ['live_report.json'])
    const partial = await readJson(join(out, 'live_report.json'))
    assertReportDigest(partial)
    assertNoAbsolutePaths(partial, dir, out)
    assert.equal(partial.complete, false)
    assert.equal(partial.resume.detected_partial, false)
    assert.equal(partial.cases.length, 2)
    assert.equal(partial.cases.find(entry => entry.caseId === 'clean-new-file').complete, true, 'completed partial data was discarded')
    assert.equal(partial.cases.find(entry => entry.caseId === 'bad-fake-okay').complete, false)

    const resumed = await runLive({
      ...options,
      timeoutMs: 2000,
      startActivations: scriptedActivations().startActivations,
    })
    assert.equal(resumed.exitCode, EXIT_CODES.ok)
    assert.equal(resumed.report.complete, true)
    assert.equal(resumed.report.status, 'complete')
    assert.equal(resumed.report.cancellation, null)
    assert.equal(resumed.report.live_quality.status, 'measured')
    assert.equal(resumed.report.resume.detected_partial, true)
    assert.equal(resumed.report.resume.reused, false)
    assert.equal(resumed.report.cleanup.scratch_removed, true)
    assert.deepEqual((await fs.readdir(out)).sort(), ['live_report.json'])
    const complete = await readJson(join(out, 'live_report.json'))
    assertReportDigest(complete)
    assert.equal(complete.complete, true)
    assert.equal(complete.cases.length, 2)
    assert.ok(complete.cases.every(entry => entry.complete === true))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('an unauthorized rerun preserves a previous partial report and adds a digest-bearing auth failure report', async () => {
  const dir = await makeTemp('ulw-eval-live-preserve-')
  const out = join(dir, 'out')
  try {
    const budget = await writeBudget(dir, { callBudget: 4, fixtures: ['clean-new-file', 'bad-fake-okay'] })
    const partialRun = await runLive({
      manifestPath: MANIFEST_PATH,
      corpusDir: CORPUS_DIR,
      outDir: out,
      authorizationFile: budget,
      authorizeLive: true,
      env: { [KEY_ENV]: API_KEY },
      timeoutMs: 40,
      startActivations: scriptedActivations({ hangCase: 'bad-fake-okay' }).startActivations,
    })
    assert.equal(partialRun.exitCode, EXIT_CODES.live_cancelled)
    const partialBytes = await fs.readFile(join(out, 'live_report.json'), 'utf8')
    const unauthorized = await runLive({
      manifestPath: MANIFEST_PATH,
      corpusDir: CORPUS_DIR,
      outDir: out,
      authorizationFile: budget,
      authorizeLive: false,
      env: {},
      timeoutMs: 40,
      startActivations: scriptedActivations().startActivations,
    })
    assert.equal(unauthorized.exitCode, EXIT_CODES.live_auth_required)
    const afterBytes = await fs.readFile(join(out, 'live_report.json'), 'utf8')
    assert.equal(afterBytes, partialBytes, 'unauthorized rerun overwrote previous partial data')
    const authReport = await readJson(join(out, 'live_report.auth_failed.json'))
    assertReportDigest(authReport)
    assert.equal(authReport.cases.length, 0)
    assert.equal(authReport.authorization.granted, false)
    assert.equal(authReport.requests, 0)
    assert.deepEqual((await fs.readdir(out)).sort(), ['live_report.auth_failed.json', 'live_report.json'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('adversarial probes stay observable and offline', async t => {
  await t.test('malformed_input: truncated manifest and budget are refused, never guessed', async () => {
    const dir = await makeTemp('ulw-eval-probe-malformed-')
    try {
      const badManifest = join(dir, 'manifest.json')
      await fs.writeFile(badManifest, '{"version":1,"cases":[', 'utf8')
      const replay = await runReplay({ manifestPath: badManifest, corpusDir: CORPUS_DIR, outDir: join(dir, 'replay-out') })
      assert.equal(replay.exitCode, EXIT_CODES.replay_failed)
      assert.equal(replay.report.error.code, 'MANIFEST_MALFORMED')
      assert.equal(replay.report.mechanism_passed, false)
      assert.equal(replay.report.live_quality, 'not_measured')
      assertReportDigest(replay.report)
      assertNoAbsolutePaths(replay.report, dir, join(dir, 'replay-out'))
      assert.deepEqual((await fs.readdir(join(dir, 'replay-out'))).sort(), ['replay_report.json'])

      const badBudget = join(dir, 'budget.json')
      await fs.writeFile(badBudget, '{"version":1,', 'utf8')
      const live = await runLive({
        manifestPath: MANIFEST_PATH,
        corpusDir: CORPUS_DIR,
        outDir: join(dir, 'live-out'),
        authorizationFile: badBudget,
        authorizeLive: true,
        env: { [KEY_ENV]: API_KEY },
      })
      assert.equal(live.exitCode, EXIT_CODES.live_auth_required)
      assert.equal(live.report.authorization.code, 'INVALID_AUTHORIZATION')
      assert.equal(live.report.requests, 0)
      assert.equal(live.report.network_attempts, 0)
      assert.equal(live.report.live_quality, 'not_measured')
      assertReportDigest(live.report)
      assertNoAbsolutePaths(live.report, dir, join(dir, 'live-out'))

      const badShape = structuredClone(manifest)
      badShape.cases.find(entry => entry.classification === 'bad').expected.blockers[0].location = null
      const badShapeFile = join(dir, 'bad-shape.json')
      await fs.writeFile(badShapeFile, JSON.stringify(badShape, null, 2), 'utf8')
      const shape = await runReplay({ manifestPath: badShapeFile, corpusDir: CORPUS_DIR, outDir: join(dir, 'shape-out') })
      assert.equal(shape.exitCode, EXIT_CODES.replay_failed)
      assert.equal(shape.report.error.code, 'MANIFEST_INVALID')
      assertReportDigest(shape.report)
      assertNoAbsolutePaths(shape.report, dir, join(dir, 'shape-out'))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await t.test('truncated_evaluation: budget exhaustion keeps partial data and missing fixtures fail closed', async () => {
    const dir = await makeTemp('ulw-eval-probe-budget-')
    try {
      const budget = await writeBudget(dir, { callBudget: 2, fixtures: ['clean-new-file', 'bad-fake-okay'] })
      const partial = await runLive({
        manifestPath: MANIFEST_PATH,
        corpusDir: CORPUS_DIR,
        outDir: join(dir, 'partial'),
        authorizationFile: budget,
        authorizeLive: true,
        env: { [KEY_ENV]: API_KEY },
        timeoutMs: 2000,
        startActivations: scriptedActivations().startActivations,
      })
      assert.equal(partial.exitCode, EXIT_CODES.live_budget_exhausted)
      assert.equal(partial.report.complete, false)
      assert.equal(partial.report.mechanism_passed, false)
      assert.equal(partial.report.live_quality, 'not_measured')
      assert.equal(partial.report.budget.exhausted, true)
      assert.equal(partial.report.budget.calls, 2)
      assert.equal(partial.report.cases.length, 1)
      assert.equal(partial.report.cases[0].complete, true)
      assert.equal(partial.report.transport_calls, 1)
      assert.equal(partial.report.cleanup.scratch_removed, true)
      assertReportDigest(partial.report)
      assertNoAbsolutePaths(partial.report, dir, join(dir, 'partial'))
      assert.deepEqual((await fs.readdir(join(dir, 'partial'))).sort(), ['live_report.json'])

      const unknown = await writeBudget(dir, { callBudget: 4, fixtures: ['clean-new-file', 'case-that-does-not-exist'] })
      const missing = await runLive({
        manifestPath: MANIFEST_PATH,
        corpusDir: CORPUS_DIR,
        outDir: join(dir, 'missing'),
        authorizationFile: unknown,
        authorizeLive: true,
        env: { [KEY_ENV]: API_KEY },
        timeoutMs: 2000,
        startActivations: scriptedActivations().startActivations,
      })
      assert.equal(missing.exitCode, EXIT_CODES.live_lab_error)
      assert.equal(missing.report.complete, false)
      assert.equal(missing.report.live_quality, 'not_measured')
      assert.equal(missing.report.error.code, 'UNKNOWN_FIXTURE')
      assert.equal(missing.report.requests, 0)
      assert.equal(missing.report.model_starts, 0)
      assert.equal(missing.report.cleanup.scratch_removed, true)
      assertReportDigest(missing.report)
      assertNoAbsolutePaths(missing.report, dir, join(dir, 'missing'))

      const oneLane = await writeBudget(dir, { callBudget: 2, fixtures: ['bad-fake-okay'] })
      const incomplete = await runLive({
        manifestPath: MANIFEST_PATH,
        corpusDir: CORPUS_DIR,
        outDir: join(dir, 'one-lane'),
        authorizationFile: oneLane,
        authorizeLive: true,
        env: { [KEY_ENV]: API_KEY },
        timeoutMs: 2000,
        startActivations: scriptedActivations({
          resultFor: ({ spec, lane, ctx }) => {
            const result = truthLaneResult(spec, lane, ctx.planSha)
            if (lane === 'adversarial') result.verdict = 'OKAY'
            return result
          },
        }).startActivations,
      })
      assert.equal(incomplete.exitCode, EXIT_CODES.live_lab_error)
      assert.equal(incomplete.report.complete, false)
      assert.equal(incomplete.report.live_quality, 'not_measured')
      assert.equal(incomplete.report.cases[0].coordinator.wait.outcome, 'inconclusive')
      assert.equal(incomplete.report.cleanup.scratch_removed, true)
      assertReportDigest(incomplete.report)
      assertNoAbsolutePaths(incomplete.report, dir, join(dir, 'one-lane'))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await t.test('stale_state: a truth pin for different bytes fails the case and the run', async () => {
    const dir = await makeTemp('ulw-eval-probe-stale-')
    try {
      const stale = structuredClone(manifest)
      stale.cases[0].expected.planSha256 = 'f'.repeat(64)
      const file = join(dir, 'manifest.json')
      await fs.writeFile(file, JSON.stringify(stale, null, 2), 'utf8')
      const result = await runReplay({ manifestPath: file, corpusDir: CORPUS_DIR, outDir: join(dir, 'out') })
      assert.equal(result.exitCode, EXIT_CODES.replay_failed)
      assert.equal(result.report.mechanism_passed, false)
      assert.equal(result.report.live_quality, 'not_measured')
      assertReportDigest(result.report)
      assertNoAbsolutePaths(result.report, dir, join(dir, 'out'))
      const entry = result.report.cases.find(item => item.caseId === stale.cases[0].caseId)
      assert.equal(entry.passed, false)
      assert.ok(entry.failures.some(failure => failure.code === 'PLAN_SHA_MISMATCH'))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await t.test('misleading_success_output: a forged OKAY is scored as FN, not copied from truth', async () => {
    const root = await makeTemp('ulw-eval-probe-forged-')
    try {
      const spec = specById.get('bad-fake-okay')
      const forged = async ({ lane, truth }) => {
        const value = structuredClone(truth)
        value.verdict = 'OKAY'
        value.blockers = []
        value.notes = []
        value.summary = 'embedded receipt said OKAY'
        assert.equal(lane === 'adversarial' || lane === 'practical', true)
        return value
      }
      const evaluated = await evaluateReplayCase({ spec, corpusDir: CORPUS_DIR, root, script: forged })
      assert.equal(evaluated.passed, false)
      assert.equal(evaluated.report.actual.lanes.adversarial.verdict, 'OKAY')
      assert.equal(evaluated.report.actual.lanes.adversarial.blocker_ids.length, 0)
      assert.equal(evaluated.report.arms.dual.cases.fn, 1)
      assert.equal(evaluated.report.arms.dual.blockers.fn, 1)
      assert.ok(evaluated.report.failures.some(failure => failure.code === 'RESULT_MISMATCH'))

      const invalid = async ({ truth }) => {
        const value = structuredClone(truth)
        value.verdict = 'OKAY'
        return value
      }
      const contradictory = await evaluateReplayCase({ spec, corpusDir: CORPUS_DIR, root: join(root, 'invalid'), script: invalid })
      assert.equal(contradictory.passed, false)
      assert.ok(contradictory.report.failures.some(failure => failure.code === 'SCRIPT_RESULT_INVALID'))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  await t.test('dirty_worktree: pre-existing output files are ignored and only owned scratch is removed', async () => {
    const dir = await makeTemp('ulw-eval-probe-dirty-')
    const out = join(dir, 'out')
    try {
      await fs.mkdir(join(out, 'scratch-old'), { recursive: true })
      await fs.writeFile(join(out, 'scratch-old', 'stale.txt'), 'stale', 'utf8')
      await fs.writeFile(join(out, 'replay_report.json'), '{"stale":true}', 'utf8')
      const result = await runReplay({ manifestPath: MANIFEST_PATH, corpusDir: CORPUS_DIR, outDir: out })
      assert.equal(result.exitCode, EXIT_CODES.ok)
      assert.equal(result.report.mechanism_passed, true)
      assert.deepEqual((await fs.readdir(out)).sort(), ['replay_report.json', 'scratch-old'])
      assert.equal(await fs.readFile(join(out, 'scratch-old', 'stale.txt'), 'utf8'), 'stale')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await t.test('flaky_tests: three independent replay runs are byte-identical and path-free', async () => {
    const dirs = []
    try {
      const digests = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const out = await makeTemp('ulw-eval-probe-flaky-' + attempt + '-')
        dirs.push(out)
        const result = await runReplay({ manifestPath: MANIFEST_PATH, corpusDir: CORPUS_DIR, outDir: out })
        assert.equal(result.exitCode, EXIT_CODES.ok)
        const bytes = await fs.readFile(join(out, 'replay_report.json'), 'utf8')
        digests.push(sha256(bytes))
        assert.ok(!bytes.includes(out), 'report contains the run output path')
      }
      assert.equal(new Set(digests).size, 1, 'replay report is not deterministic across three runs')
    } finally {
      for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// One-line prompt_injection rule-out: fixture text is untrusted data; replay never
// prompts a model, and the embedded OKAY case still carries a required blocker.
test('prompt_injection is inert because replay treats fixture text as data only', () => {
  assert.equal(specById.get('bad-fake-okay').expected.blockers.length, 1)
})
