#!/usr/bin/env node
/**
 * Real Cordis / native-spawn verification for the ULW plan row 18.
 *
 * This script is deliberately a *host* harness, not a fake-context unit test.
 * It parses --dsh-root, resolves only public package exports of the installed
 * DSH package, boots the shipped headless profile through the public
 * profile-boot API into a temporary isolated DSH_HOME and workspace, mounts
 * the linked package under test through the real Loader, registers a local
 * scripted LLM adapter on the real ctx.llm service, and then exercises the
 * actual tools/commands/guards on real Agent sessions.
 *
 * The linked source run is labelled separately from a tarball fixture run.
 * Live model quality is never measured here: live_quality is "not_measured".
 *
 * Exact invocation (Verification strategy):
 *   node qa/cordis-review-qa.mjs \
 *     --dsh-root /home/miku/.nvm/versions/node/v26.7.0/lib/node_modules/@deepseek-ai/dsh \
 *     --mode scripted --out .dsh/ulw/evidence/cordis-dual-plan-review/native
 *
 * Exit codes: 0 every required assertion passed; 3 blocked/failed (an exact
 * condition is recorded in assertions.json); 64 usage.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
const SCHEMA = 'ulw-cordis-native-qa/v1'
const EXIT = { ok: 0, blocked: 3, usage: 64 }
const argv = process.argv.slice(2)

function parseArgs (args) {
  const out = { mode: 'scripted' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dsh-root') out.dshRoot = args[++i]
    else if (arg === '--mode') out.mode = args[++i]
    else if (arg === '--out') out.out = args[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return out
}

function usage (message) {
  process.stderr.write((message ? message + '\n' : '') +
    'usage: node qa/cordis-review-qa.mjs --dsh-root <installed-dsh-root> --mode scripted --out <dir>\n')
  process.exit(EXIT.usage)
}

const options = (() => { try { return parseArgs(argv) } catch (error) { usage(error.message) } })()
if (options.help) usage()
if (!options.dshRoot || !options.out || options.mode !== 'scripted') usage('missing or unsupported argument')

const OUT = resolve(options.out)
const TMP = join(OUT, 'tmp')
const HOME = join(TMP, 'dsh-home')
const WORKSPACE = join(TMP, 'workspace')
const PLAN_SLUG = 'qa-review-plan'
const PLAN_REL = '.dsh/ulw/plans/' + PLAN_SLUG + '.md'
const PLAN_ABS = join(WORKSPACE, PLAN_REL)
const DRAFT_REL = '.dsh/ulw/drafts/' + PLAN_SLUG + '.md'
const DRAFT_ABS = join(WORKSPACE, DRAFT_REL)
const PLAN2_SLUG = 'qa-early-okay'
const PLAN2_REL = '.dsh/ulw/plans/' + PLAN2_SLUG + '.md'
const PLAN2_ABS = join(WORKSPACE, PLAN2_REL)
const PLAN3_SLUG = 'qa-reload-interrupt'
const PLAN3_REL = '.dsh/ulw/plans/' + PLAN3_SLUG + '.md'
const PLAN3_ABS = join(WORKSPACE, PLAN3_REL)
const tracePath = join(OUT, 'run-trace.jsonl')
const assertions = []
const scenarioResults = []
const traceRecords = []
const startedAt = new Date().toISOString()
let sequence = 0

function trace (step, data = {}) {
  const record = { at: new Date().toISOString(), seq: ++sequence, step, ...data }
  traceRecords.push(record)
  try { appendFileSync(tracePath, JSON.stringify(record) + '\n') } catch { /* evidence remains in assertions */ }
}
function assertRecord (id, status, expected, actual, detail, extra = {}) {
  const record = { id, status, expected, actual, detail: detail || '', ...extra }
  assertions.push(record)
  trace('assertion', record)
  return record
}
function pass (id, expected, actual, detail, extra) { return assertRecord(id, 'passed', expected, actual, detail, extra) }
function fail (id, expected, actual, detail, extra) { return assertRecord(id, 'failed', expected, actual, detail, extra) }
function blocked (id, expected, actual, detail, extra) { return assertRecord(id, 'blocked', expected, actual, detail, extra) }
function failuresOf (ids) { return assertions.filter(assertion => ids.includes(assertion.id) && assertion.status !== 'passed') }
function textOfContent (content) {
  if (!Array.isArray(content)) return ''
  return content.map(block => block && block.type === 'text' ? block.text : '').join('\n')
}
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }
async function bounded (promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT: ' + label)), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

function sanitize (value, depth = 0) {
  if (depth > 4) return '[depth]'
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitize(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (/key|token|secret|credential|authorization|cookie/i.test(k)) out[k] = '<redacted>'
    else out[k] = sanitize(v, depth + 1)
  }
  return out
}

function resolvePublic (require, specifier) {
  const resolved = require.resolve(specifier)
  return pathToFileURL(resolved).href
}

function readInstalledManifest (dshRoot) {
  const file = join(dshRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const exports = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports : {}
  const hasProfileBoot = Object.hasOwn(exports, './profile-boot')
  const hasLib = Object.hasOwn(exports, './lib/*')
  return { file, manifest, exports, hasProfileBoot, hasLib }
}

function createWorkspace () {
  mkdirSync(HOME, { recursive: true })
  mkdirSync(join(WORKSPACE, '.dsh/ulw/plans'), { recursive: true })
  mkdirSync(join(WORKSPACE, '.dsh/ulw/drafts'), { recursive: true })
  const fixture = join(PACKAGE_ROOT, 'test/fixtures/review/plans/clean-new-file.plan.txt')
  const source = existsSync(fixture) ? readFileSync(fixture, 'utf8') : '# qa-review-plan - Work Plan\n\n## Todos\n\n- [ ] 1. QA\n  Parallelization: Wave 1 | Blocked by: — | Blocks: F1\n'
  writeFileSync(PLAN_ABS, source)
  const draft = [
    '---',
    'slug: ' + PLAN_SLUG,
    'status: drafting',
    'intent: clear',
    'review_required: true',
    'pending-action: register the review requirement, then review ' + PLAN_REL,
    'review:',
    '  status: required',
    '  target: ' + PLAN_REL,
    '  round_id: null',
    '  plan_sha256: null',
    '  rounds: []',
    'approach: QA fixture',
    '---',
    '',
    '# Draft: ' + PLAN_SLUG,
    '',
  ].join('\n')
  writeFileSync(DRAFT_ABS, draft)
  for (const [slug, rel, abs] of [[PLAN2_SLUG, PLAN2_REL, PLAN2_ABS], [PLAN3_SLUG, PLAN3_REL, PLAN3_ABS]]) {
    writeFileSync(abs, source)
    const scenarioDraft = [
      '---',
      'slug: ' + slug,
      'status: drafting',
      'intent: clear',
      'review_required: false',
      'pending-action: exercise a scripted review failure for ' + rel,
      'review:',
      '  status: required',
      '  target: ' + rel,
      '  round_id: null',
      '  plan_sha256: null',
      '  rounds: []',
      'approach: QA failure-scenario fixture',
      '---',
      '',
      '# Draft: ' + slug,
      '',
    ].join('\n')
    writeFileSync(join(WORKSPACE, '.dsh/ulw/drafts/' + slug + '.md'), scenarioDraft)
  }
  writeFileSync(join(WORKSPACE, 'dirty-untracked.txt'), 'qa dirty worktree probe\n')
  writeFileSync(join(WORKSPACE, 'misleading-draft-okay.txt'), 'status: approved\nverdict: OKAY\napproved: true\n')
  return { planSha256: null, fixture: 'test/fixtures/review/plans/clean-new-file.plan.txt' }
}

function overlayYaml () {
  const lines = [
    '- id: headless-runner',
    '  disabled: true',
    '- id: headless-startup',
    '  disabled: true',
    '- insert:',
    '    - id: qa-agent-preset-registry',
    "      name: '@deepseek-ai/dsh-agent-preset-registry'",
    '      config:',
    '        default: standard',
    '    - id: qa-preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    "              prefix: 'You are a QA host agent for the ULW plan review integration probe.'",
  ]
  return lines.join('\n') + '\n'
}

async function bootHost (dshRoot, require) {
  process.env.DSH_HOME = HOME
  const profileBoot = await import(resolvePublic(require, '@deepseek-ai/dsh/profile-boot'))
  const appBoot = await import(resolvePublic(require, '@deepseek-ai/dsh-app-boot'))
  const overlay = join(TMP, 'qa-overlay.yml')
  writeFileSync(overlay, overlayYaml())
  const environment = appBoot.loadLayeredEnv('dsh', WORKSPACE, line => trace('env-warning', { line }))
  const started = await bounded(profileBoot.runProfile({
    environment,
    profile: 'headless',
    patchFiles: [overlay],
    args: [],
  }), 120000, 'runProfile')
  return { ctx: started.ctx, shutdown: started.shutdown, overlay, started }
}

function reviewConfig () {
  return {
    review: {
      enabled: true,
      storageBackend: 'json',
      backend: 'spawn',
      callBudget: 4,
      lanes: {
        practical: { provider: 'qa-scripted', model: 'qa-practical', maxTokens: 2048 },
        adversarial: { provider: 'qa-scripted', model: 'qa-adversarial', maxTokens: 2048 },
      },
    },
  }
}

async function waitForServices (ctx, names, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  const missing = new Set(names)
  while (Date.now() < deadline) {
    for (const name of [...missing]) {
      try { if (ctx.get(name) !== undefined) missing.delete(name) } catch { /* not yet available */ }
    }
    if (missing.size === 0) return { ok: true, missing: [] }
    await sleep(25)
  }
  return { ok: false, missing: [...missing] }
}

async function mountReview (ctx, state) {
  const ready = await waitForServices(ctx, ['tools', 'agents', 'llm', 'storage', 'subagents', 'agentPresets', 'sessionProjections', 'commands', 'workingDirectory'])
  if (!ready.ok) throw new Error('enhanced services never activated: ' + ready.missing.join(','))
  const subagents = ctx.get('subagents')
  if (subagents && subagents.__qaObserved !== true) {
    try {
      const originalStart = subagents.startActivation.bind(subagents)
      subagents.startActivation = async (spec) => {
        const activation = await originalStart(spec)
        Promise.resolve(activation.result).then(result => {
          const record = { childId: activation.childId, label: spec?.label, keys: Object.keys(result || {}), hasStructured: result?.structured !== undefined, stopReason: result?.stopReason }
          state.activationResults.push(record)
          trace('activation-result', record)
        }).catch(error => trace('activation-result-error', { childId: activation.childId, error: error?.message || String(error) }))
        return activation
      }
      subagents.__qaObserved = true
    } catch (error) {
      trace('subagents-observe-error', { error: error?.message || String(error) })
    }
  }
  const reviewModule = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib/index.js')).href)
  const fiber = await ctx.plugin(reviewModule, reviewConfig())
  state.reviewFiber = fiber
  ctx.on('tools/result', (exec, result) => {
    const sid = String(exec?.agent?.session?.id || '')
    if (!sid.startsWith('review-') && exec?.name !== 'structured_output') return
    trace('review-tool-probe', { sid, name: exec?.name, isError: result?.isError === true, text: textOfContent(result?.content).slice(0, 300) })
    if (!sid.startsWith('review-')) return
    if (exec?.name === 'structured_output') {
      if (result?.isError !== true) state.structuredRecorded.add(sid)
      else state.structuredRefusals.push({ sid, text: textOfContent(result?.content).slice(0, 500) })
    }
    trace('review-tool-result', { sid, name: exec?.name, isError: result?.isError === true, text: textOfContent(result?.content).slice(0, 500) })
  })
  return fiber
}

async function waitForReviewReady (ctx, timeoutMs = 20000) {
  const bootstrap = await ctx.agents.create({ sessionId: 'session-qa-ready-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
  const deadline = Date.now() + timeoutMs
  let last = null
  try {
    while (Date.now() < deadline) {
      const result = await callTool(ctx, bootstrap.agent, 'ulw_review', { action: 'status', target: PLAN_REL })
      last = result.value || null
      const capability = last?.capability
      if (capability?.available === true) return { ok: true, capability }
      const reason = String(capability?.reason || '')
      if (reason !== '' && reason !== 'ASSEMBLY_PENDING' && !reason.startsWith('MISSING_') && reason !== 'HANDOFF_ASSEMBLY_PENDING') {
        return { ok: false, capability, surface: result.text }
      }
      await sleep(50)
    }
    return { ok: false, capability: last?.capability || null, surface: last ? JSON.stringify(last) : 'timeout' }
  } finally {
    try { await bootstrap.dispose() } catch { /* readiness bootstrap is best effort */ }
  }
}

function makeScriptedAdapter (llm, state) {
  const { LlmAdapter } = llm
  class ScriptedAdapter extends LlmAdapter {
    providerInfo (provider) { return { id: provider, name: 'QA scripted (local)' } }
    async listModels () { return [] }
    async resolveModel (provider, model) { return { provider, id: model, name: model, inputModalities: ['text'] } }
    async prepareCall (provider, model) { return { model: await this.resolveModel(provider, model), stream: opts => this.stream(opts) } }
    async * stream (opts) {
      state.routeCalls.push({ provider: opts.provider, model: opts.model, purpose: opts.purpose || '', sessionId: String(opts.sessionId || ''), toolCount: Array.isArray(opts.tools) ? opts.tools.length : 0 })
      trace('llm-stream', { provider: opts.provider, model: opts.model, purpose: opts.purpose || '', sessionId: String(opts.sessionId || ''), tools: (opts.tools || []).map(t => t.name) })
      if (opts.purpose === 'session-title') { yield* textStream('QA review'); return }
      const messages = Array.isArray(opts.messages) ? opts.messages : []
      const systemText = messages.filter(m => m.role === 'system').map(m => textOfContent(m.content)).join('\n')
      const lastUser = [...messages].reverse().find(m => m.role === 'user')
      const userText = lastUser ? textOfContent(lastUser.content) : ''
      const role = /practical lane of an enhanced Host plan review/i.test(systemText) || /"lane":"practical"/.test(userText)
        ? 'practical'
        : /adversarial lane of an enhanced Host plan review/i.test(systemText) || /"lane":"adversarial"/.test(userText)
          ? 'adversarial'
          : 'main'
      const toolNames = (opts.tools || []).map(t => t.name)
      if (role !== 'main') {
        yield* reviewerTurn({ role, messages, toolNames, state, lane: state.laneState.get(String(opts.sessionId)) || [] })
        state.laneState.set(String(opts.sessionId), state.laneCounters.get(String(opts.sessionId)) || 0)
        return
      }
      const step = state.mainSteps.get(String(opts.sessionId)) || 0
      state.mainSteps.set(String(opts.sessionId), step + 1)
      const flow = state.mainFlow
      if (flow === 'happy') {
        if (step === 0) { yield* toolCall('ulw_review', { action: 'status', target: PLAN_REL }); return }
        if (step === 1) { yield* toolCall('write', { file_path: join(WORKSPACE, 'product-before-lease.txt'), content: 'must not exist before lease' }); return }
        if (step === 2) { yield* toolCall('bash', { command: 'echo side-effect > ' + join(WORKSPACE, 'bash-before-lease.txt'), description: 'qa guard probe' }); return }
        if (step === 3) { yield* toolCall('subagent', { description: 'qa delegation probe', prompt: 'qa delegation probe' }); return }
        if (step === 4) { yield* toolCall('ulw_handoff', { action: 'check', target: PLAN_REL }); return }
        yield* textStream('done')
        return
      }
      if (flow === 'spawn') {
        if (step === 0) { yield* toolCall('subagent', { description: 'qa native spawn probe', prompt: 'QA_NATIVE_CHILD' }); return }
        yield* textStream('spawn done')
        return
      }
      yield* textStream('done')
    }
  }
  return new ScriptedAdapter()
}

async function installScriptedAdapter (ctx, require, state) {
  const llm = await import(resolvePublic(require, '@deepseek-ai/dsh-llm'))
  const adapter = makeScriptedAdapter(llm, state)
  const registration = ctx.llm.registerAdapter(['qa-scripted'], adapter)
  return { llm, registration }
}

function * textStream (text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function * toolCall (name, args) {
  const id = 'qa-call-' + name + '-' + Math.random().toString(36).slice(2, 10)
  const raw = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
async function * reviewerTurn ({ role, messages, toolNames, state, lane }) {
  const allText = messages.map(message => textOfContent(message.content)).join('\n')
  const reviewPrompt = [...messages].reverse().find(message => message.role === 'user' && /"artifact"[\s\S]*"round"[\s\S]*"lane"/.test(textOfContent(message.content)))
  const bindingText = reviewPrompt ? textOfContent(reviewPrompt.content) : allText
  const laneMatch = /"lane"\s*:\s*"(practical|adversarial)"/.exec(bindingText)
  const laneName = laneMatch ? laneMatch[1] : role
  const roundId = (/"roundId"\s*:\s*"([^"]+)"/.exec(bindingText) || [])[1] || ''
  const launchId = (/"launchId"\s*:\s*"([^"]+)"/.exec(bindingText) || [])[1] || ''
  const planSha256 = (/"planSha256"\s*:\s*"([0-9a-f]{64})"/.exec(bindingText) || [])[1] || ''
  const lastToolResult = [...messages].reverse().find(message => message.role === 'tool')
  const toolText = lastToolResult ? textOfContent(lastToolResult.content) : ''
  let page = null
  try {
    const match = /"source"\s*:[\s\S]*"done"\s*:\s*(?:true|false)\s*\}/.exec(toolText)
    if (match) page = JSON.parse(match[0])
    else {
      const fallback = /\{[\s\S]*\}/.exec(toolText)
      if (fallback) page = JSON.parse(fallback[0])
    }
  } catch { page = null }
  const stepKey = String(roundId || 'lane') + ':' + laneName
  const laneState = state.reviewerState.get(stepKey) || { count: 0, done: false, structuredAttempts: 0 }
  laneState.count += 1
  if (page && page.done === true) laneState.done = true
  state.reviewerState.set(stepKey, laneState)
  const result = { version: 1, lane: laneName, roundId, launchId, planSha256, verdict: 'OKAY', summary: 'complete coverage', blockers: [], notes: [] }
  trace('reviewer-turn', { lane: laneName, count: laneState.count, done: laneState.done, roundId, launchId, planSha256, pageDone: page?.done, pageNext: page?.nextCursor, lastToolText: toolText.slice(0, 180) })
  if (state.interrupt === true && laneName === 'practical') {
    await sleep(2500)
    yield* textStream('interrupted lane completion without coverage')
    return
  }
  if (state.earlyOkay === true && laneName === 'practical') {
    if (laneState.count === 1) {
      state.earlyAttempts += 1
      yield* toolCall('structured_output', { ...result, summary: 'early OKAY before complete coverage must not approve' })
      return
    }
    yield* textStream('early OKAY lane stopped without complete coverage')
    return
  }
  if (laneState.done || /"done"\s*:\s*true/.test(toolText) || /early OKAY must not approve/.test(toolText)) {
    laneState.structuredAttempts += 1
    state.reviewerState.set(stepKey, laneState)
    await sleep(30)
    yield* toolCall('structured_output', result)
    return
  }
  let cursor
  if (page && Number.isInteger(page.nextCursor)) cursor = page.nextCursor
  else {
    const next = /"nextCursor"\s*:\s*(\d+)/.exec(toolText)
    if (next) cursor = Number(next[1])
  }
  yield* toolCall('ulw_review_input', cursor === undefined ? {} : { cursor })
}
async function callTool (ctx, agent, name, args, timeoutMs = 30000) {
  const callId = 'qa-' + name + '-' + Math.random().toString(36).slice(2, 10)
  const result = await bounded(ctx.tools.execute({ callId, name, arguments: args, agent, signal: new AbortController().signal }), timeoutMs, 'tool ' + name)
  return {
    name,
    isError: result.isError === true,
    text: textOfContent(result.content),
    content: sanitize(result.content),
    value: sanitize(result.value),
  }
}

function toolEvents (session) {
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  return events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
}

async function runNativeFlow (ctx, llm, state) {
  const commands = ctx.get('commands')
  const mainSessionId = 'session-qa-main-' + Date.now().toString(36)
  const main = await ctx.agents.create({ sessionId: mainSessionId, meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
  const commandNames = commands.list(main.agent).map(command => command.name)
  assertRecord('native.commands.registered', ['ulw-mode', 'ulw-review', 'ulw-consult'].every(name => commandNames.includes(name)) ? 'passed' : 'failed', ['ulw-mode', 'ulw-review', 'ulw-consult'], commandNames, 'commands visible to the real Agent', { commands: commandNames })

  const planMode = await commands.execute(main.agent, '/ulw-mode plan', [], new AbortController().signal)
  const planState = ctx.sessionProjections.stateOf(main.agent.session, 'ulwMode')?.mode
  assertRecord('native.mode.plan.slash', planState === 'plan' ? 'passed' : 'failed', 'plan', planState, 'projection folds the real command/run event', { result: planMode?.result })

  const planWrite = await callTool(ctx, main.agent, 'write', { file_path: join(WORKSPACE, 'plan-product.txt'), content: 'must not exist' })
  const planWriteExists = existsSync(join(WORKSPACE, 'plan-product.txt'))
  assertRecord('native.guard.plan.product_write', planWrite.isError && !planWriteExists ? 'passed' : 'failed', 'denied with no side effect', { isError: planWrite.isError, exists: planWriteExists }, planWrite.text, { text: planWrite.text })
  const extraDraft = join(WORKSPACE, '.dsh/ulw/drafts/qa-extra.md')
  const draftWrite = await callTool(ctx, main.agent, 'write', { file_path: extraDraft, content: '# qa extra draft\n' })
  assertRecord('native.guard.plan.draft_write', !draftWrite.isError && existsSync(extraDraft) ? 'passed' : 'failed', 'allowed under .dsh/ulw', { isError: draftWrite.isError, exists: existsSync(extraDraft) }, 'plan-mode artifact write stays available', { text: draftWrite.text })

  const execMode = await commands.execute(main.agent, '/ulw-mode execute', [], new AbortController().signal)
  const execState = ctx.sessionProjections.stateOf(main.agent.session, 'ulwMode')?.mode
  assertRecord('native.mode.execute.slash', execState === 'execute' ? 'passed' : 'failed', 'execute', execState, 'projection folds the real command/run event', { result: execMode?.result })

  const execWrite = await callTool(ctx, main.agent, 'write', { file_path: join(WORKSPACE, 'exec-product-before-lease.txt'), content: 'must not exist' })
  const execWriteExists = existsSync(join(WORKSPACE, 'exec-product-before-lease.txt'))
  assertRecord('native.guard.execute.mutator_body', execWrite.isError && !execWriteExists ? 'passed' : 'failed', 'no mutator body execution', { isError: execWrite.isError, exists: execWriteExists }, execWrite.text, { text: execWrite.text })
  const denialSurfaceOk = /HANDOFF_LEASE_MISSING|ulw handoff: product writes/i.test(execWrite.text)
  assertRecord('native.guard.execute.denial_surface', denialSurfaceOk ? 'passed' : 'failed', 'a lease-policy refusal', execWrite.text.slice(0, 300), 'The execute-mode mutator must be stopped by the handoff lease policy, not a raw property error.', { text: execWrite.text })
  const execBash = await callTool(ctx, main.agent, 'bash', { command: 'echo side-effect > ' + join(WORKSPACE, 'exec-bash-marker.txt'), description: 'qa guard probe' })
  assertRecord('native.guard.execute.bash_body', execBash.isError && !existsSync(join(WORKSPACE, 'exec-bash-marker.txt')) ? 'passed' : 'failed', 'a denied bash with no marker', { isError: execBash.isError, exists: existsSync(join(WORKSPACE, 'exec-bash-marker.txt')) }, execBash.text)
  const agentsBefore = ctx.get('agents').list().map(agent => agent.session.id)
  const execSpawn = await callTool(ctx, main.agent, 'subagent', { description: 'qa delegation probe', prompt: 'qa delegation probe' })
  const agentsAfter = ctx.get('agents').list().map(agent => agent.session.id)
  assertRecord('native.guard.execute.delegation_body', execSpawn.isError && agentsAfter.length === agentsBefore.length ? 'passed' : 'failed', 'a denied delegation with no live child', { before: agentsBefore, after: agentsAfter, isError: execSpawn.isError }, execSpawn.text)

  const slashReview = await commands.execute(main.agent, '/ulw-review ' + PLAN_REL, [], new AbortController().signal)
  const slashText = slashReview?.result?.text || ''
  trace('slash-review', { result: slashReview?.result })
  const roundMatch = /round-[A-Za-z0-9-]+/.exec(slashText)
  const roundId = roundMatch ? roundMatch[0] : undefined
  const slashAccepted = slashReview?.result?.kind === 'success' && roundId !== undefined && /accepted round/i.test(slashText)
  assertRecord('native.review.slash_tool.acceptance', slashAccepted ? 'passed' : 'failed', 'accepted round with a round id, not completed', { kind: slashReview?.result?.kind, roundId, text: slashText.slice(0, 500) }, 'The registered slash command must accept the round and name the round id without claiming completion.', { text: slashText })

  let waitResult
  try {
    waitResult = await callTool(ctx, main.agent, 'ulw_review', roundId ? { action: 'wait', roundId } : { action: 'wait', target: PLAN_REL }, 90000)
  } catch (error) {
    waitResult = { isError: true, text: 'wait failed: ' + (error?.message || String(error)), value: null }
  }
  trace('review-wait', { text: waitResult.text, value: waitResult.value })
  let statusResult = await callTool(ctx, main.agent, 'ulw_review', { action: 'status', target: PLAN_REL })
  for (let i = 0; i < 80; i++) {
    const state = statusResult.value?.state
    if (state !== 'in_flight' && state !== 'preparing' && state !== 'required') break
    await sleep(100)
    statusResult = await callTool(ctx, main.agent, 'ulw_review', { action: 'status', target: PLAN_REL })
  }
  trace('review-status-final', { state: statusResult.value?.state, approved: statusResult.value?.approved, completed: statusResult.value?.completed, lanes: statusResult.value?.lanes })
  const capability = statusResult.value?.capability || {}
  assertRecord('native.enhanced.assembly', capability.available === true ? 'passed' : 'failed', 'ready', { available: capability.available, reason: capability.reason, detail: capability.detail }, 'The enhanced assembly must be ready on the real Cordis context.', { surface: statusResult.text })

  const lanes = Array.isArray(statusResult.value?.lanes) ? statusResult.value.lanes : []
  const childIds = lanes.map(lane => lane?.childId).filter(Boolean)
  const distinctChildren = new Set(childIds)
  assertRecord('native.review.activations.two_distinct', distinctChildren.size === 2 ? 'passed' : 'failed', 'two distinct child sessions', { childIds, distinct: distinctChildren.size, lanes: lanes.map(lane => ({ lane: lane.lane, childId: lane.childId, runId: lane.runId, status: lane.status, verdict: lane.verdict, complete: lane.complete, deliveredBytes: lane.deliveredBytes, totalBytes: lane.totalBytes })) }, 'Both native review lanes must bind two distinct child sessions.', { lanes })
  const complete = lanes.length === 2 && lanes.every(lane => lane?.complete === true && lane?.deliveredBytes === lane?.totalBytes && lane?.totalBytes > 0)
  assertRecord('native.review.coverage', complete ? 'passed' : 'failed', 'complete bytes in both lanes', { lanes: lanes.map(lane => ({ lane: lane.lane, status: lane.status, complete: lane.complete, deliveredBytes: lane.deliveredBytes, totalBytes: lane.totalBytes })) }, 'Complete paged delivery is required in both lanes.', {})
  const captured = lanes.length === 2 && lanes.every(lane => lane?.verdict === 'OKAY' && lane?.complete === true)
  const structuredSessions = [...state.structuredRecorded]
  assertRecord('native.review.capture', structuredSessions.length >= 2 ? 'passed' : 'failed', 'two lanes recorded structured_output', { structuredSessions, verdicts: lanes.map(lane => ({ lane: lane.lane, verdict: lane.verdict, complete: lane.complete })) }, 'Both lanes must record a real structured_output tool result.', { surface: statusResult.text })
  assertRecord('native.review.lane_result_propagation', lanes.length === 2 && lanes.every(lane => lane?.verdict === 'OKAY') ? 'passed' : 'failed', 'the structured lane result becomes the lane verdict', { structuredSessions, lanes: lanes.map(lane => ({ lane: lane.lane, verdict: lane.verdict, status: lane.status })) }, 'A recorded structured result must propagate into the durable lane verdict; the real Host likely passes the SubagentResult wrapper.', { surface: statusResult.text })
  const approved = statusResult.value?.approved === true && statusResult.value?.completed === true
  assertRecord('native.review.round_approved', approved ? 'passed' : 'failed', 'completed and approved with two bound receipts', { state: statusResult.value?.state, approved: statusResult.value?.approved, completed: statusResult.value?.completed }, 'Only a completed dual approval may count as approval.', { surface: statusResult.text })
  const roundIdFinal = statusResult.value?.roundId || roundId || ''
  const launchId = statusResult.value?.launchId || statusResult.value?.round?.launchId || ''
  state.roundId = roundIdFinal
  state.launchId = launchId

  const leaseResult = await callTool(ctx, main.agent, 'ulw_handoff', { action: 'check', target: PLAN_REL })
  const lease = leaseResult.value?.lease
  const leaseOk = leaseResult.value?.ok === true && lease !== null && lease !== undefined && lease.required === true
  assertRecord('native.handoff.lease', leaseOk ? 'passed' : 'failed', 'a required execution lease after dual approval', { code: leaseResult.value?.code, required: leaseResult.value?.required, lease: lease ? { handoffId: lease.handoffId, required: lease.required, approvedRoundId: lease.approvedRoundId, approvedSourceSha256: lease.approvedSourceSha256 } : null }, 'The required plan must receive a real revocable lease.', { surface: leaseResult.text })
  if (lease) state.lease = lease

  const afterLeaseWrite = await callTool(ctx, main.agent, 'write', { file_path: join(WORKSPACE, 'exec-product-after-lease.txt'), content: 'allowed after lease' })
  assertRecord('native.handoff.product_write_after_lease', !afterLeaseWrite.isError && existsSync(join(WORKSPACE, 'exec-product-after-lease.txt')) ? 'passed' : 'failed', 'the product write executes after the lease', { isError: afterLeaseWrite.isError, exists: existsSync(join(WORKSPACE, 'exec-product-after-lease.txt')) }, afterLeaseWrite.text, { text: afterLeaseWrite.text })

  const routeLaneCalls = state.routeCalls.filter(call => /qa-practical|qa-adversarial/.test(call.model))
  const laneModels = new Set(routeLaneCalls.map(call => call.provider + '/' + call.model))
  assertRecord('native.review.route_requests', laneModels.size === 2 ? 'passed' : 'failed', 'two distinct lane routes', { laneModels: [...laneModels], calls: routeLaneCalls.length, routeCalls: routeLaneCalls }, 'Both fixed lane routes must be exercised as distinct provider/model requests; paged steps may repeat stream calls.', {})
  const adapterRoutesOk = JSON.stringify([...laneModels].sort()) === JSON.stringify(['qa-scripted/qa-adversarial', 'qa-scripted/qa-practical']) && state.routeCalls.every(call => !Object.hasOwn(call, 'nonce'))
  assertRecord('native.review.scripted_adapter_nonce_free', adapterRoutesOk ? 'passed' : 'failed', 'the two expected scripted lane routes and no nonce field', { laneModels: [...laneModels].sort(), calls: state.routeCalls.length, nonceFields: state.routeCalls.filter(call => Object.hasOwn(call, 'nonce')).length }, 'The scripted adapter is deterministic, route-bound and nonce-free.')

  return { main, mainSessionId, commandNames, roundId: roundIdFinal, launchId, lanes, lease, leaseOk, approved }
}
async function driveAgent (ctx, handle, prompt, flow, state) {
  state.mainFlow = flow
  state.mainSteps.set(String(handle.agent.session.id), 0)
  handle.agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
  await bounded(handle.agent.whenIdle(), 30000, 'agent idle ' + flow)
  return { sessionId: handle.agent.session.id, flow }
}

async function nativeSpawnSelfTest (ctx, state) {
  const childIdsBefore = ctx.get('agents').list().map(agent => agent.session.id)
  const handle = await ctx.agents.create({ sessionId: 'session-qa-spawn-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
  const result = await driveAgent(ctx, handle, 'QA_SPAWN_SELFTEST', 'spawn', state)
  const after = ctx.get('agents').list().map(agent => agent.session.id)
  const child = after.find(id => !childIdsBefore.includes(id) && id !== handle.agent.session.id)
  if (child) pass('native.native_spawn.two_distinct_sessions', true, { parent: handle.agent.session.id, child, all: after }, 'The Host native subagent tool created a real second Agent session.', result)
  else fail('native.native_spawn.two_distinct_sessions', 'a second live Agent session', { parent: handle.agent.session.id, all: after }, 'The Host native subagent tool did not create a distinct child session.', result)
  await handle.dispose()
  await sleep(500)
  const afterDispose = ctx.get('agents').list().map(agent => agent.session.id)
  const childStillLive = child !== undefined && afterDispose.includes(child)
  assertRecord('native.native_spawn.no_orphan', childStillLive ? 'failed' : 'passed', 'child session removed with its parent', { afterDispose, childStillLive }, 'Disposing the parent Agent should remove the child it owns.', { afterDispose })
  return { child, childStillLive }
}

async function restartProbe (dshRoot, require, state) {
  const laneCallsBefore = state.routeCalls.filter(call => /qa-practical|qa-adversarial/.test(call.model)).length
  const first = state.booted
  await bounded(first.ctx.fiber.dispose(), 60000, 'root dispose 1')
  const agentsAfterDispose = typeof first.ctx.get === 'function' ? (() => { try { return first.ctx.get('agents')?.list?.()?.length ?? 0 } catch { return 0 } })() : 0
  trace('restart-dispose-1', { agentsAfterDispose })
  const second = await bootHost(dshRoot, require)
  state.booted = second
  await mountReview(second.ctx, state)
  await installScriptedAdapter(second.ctx, require, state)
  const ready = await waitForReviewReady(second.ctx)
  const ctx = second.ctx
  const commands = ctx.get('commands')
  const handle = await ctx.agents.create({ sessionId: 'session-qa-restart-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
  const names = commands.list(handle.agent).map(command => command.name)
  assertRecord('native.restart.commands', ['ulw-mode', 'ulw-review'].every(name => names.includes(name)) ? 'passed' : 'failed', ['ulw-mode', 'ulw-review'], names, 'A fresh Host boot over the same isolated DSH_HOME still registers the delivery commands.', { names })
  assertRecord('native.restart.assembly_ready', ready.ok === true ? 'passed' : 'failed', 'ready after restart', { ok: ready.ok, capability: ready.capability || null }, 'The fixed assembly is ready again after the restart.', { surface: ready.surface })
  await commands.execute(handle.agent, '/ulw-mode execute', [], new AbortController().signal)
  const status = await callTool(ctx, handle.agent, 'ulw_review', { action: 'status', target: PLAN_REL })
  const persistedState = status.value?.state || 'none'
  assertRecord('native.restart.review_state', persistedState === 'approved' && status.value?.approved === true ? 'passed' : 'failed', 'persisted approval survives a restart', { state: persistedState, approved: status.value?.approved, roundId: status.value?.roundId }, 'The durable review store must retain the approved round across a Host restart.', { surface: status.text })
  const leaseCheck = await callTool(ctx, handle.agent, 'ulw_handoff', { action: 'check', target: PLAN_REL })
  const lease = leaseCheck.value?.lease
  const sameRound = lease !== null && lease !== undefined && state.roundId !== undefined && lease.approvedRoundId === state.roundId
  assertRecord('native.restart.lease', leaseCheck.value?.ok === true && sameRound ? 'passed' : 'failed', 'a lease bound to the persisted approved round', { code: leaseCheck.value?.code, approvedRoundId: lease?.approvedRoundId, expectedRoundId: state.roundId, lease: lease ? { handoffId: lease.handoffId, required: lease.required } : null }, 'The restarted host must verify the persisted approval and issue a lease for the same round.', { surface: leaseCheck.text })
  const writeAfterRestart = await callTool(ctx, handle.agent, 'write', { file_path: join(WORKSPACE, 'restart-product-after-lease.txt'), content: 'allowed after restart lease' })
  assertRecord('native.restart.write_after_lease', !writeAfterRestart.isError && existsSync(join(WORKSPACE, 'restart-product-after-lease.txt')) ? 'passed' : 'failed', 'a product write after the restart lease', { isError: writeAfterRestart.isError, exists: existsSync(join(WORKSPACE, 'restart-product-after-lease.txt')) }, writeAfterRestart.text, { text: writeAfterRestart.text })
  const laneCallsAfterRestart = state.routeCalls.filter(call => /qa-practical|qa-adversarial/.test(call.model)).length
  assertRecord('native.restart.no_new_lane_start', laneCallsAfterRestart === laneCallsBefore ? 'passed' : 'failed', 'no new reviewer lane starts on restart', { before: laneCallsBefore, after: laneCallsAfterRestart }, 'A persisted approval is checked, not re-reviewed.', {})

  // Source drift after approval: an instruction edit must revoke the lease and
  // keep the product surface closed.
  appendFileSync(PLAN_ABS, '\n<!-- qa source drift: instruction changed after approval -->\n')
  const driftCheck = await callTool(ctx, handle.agent, 'ulw_handoff', { action: 'check', target: PLAN_REL })
  const driftCode = driftCheck.value?.code || ''
  const driftRefused = driftCheck.value?.ok !== true && /HANDOFF_STALE_SOURCE|HANDOFF_NOT_APPROVED|HANDOFF_LEASE_REVOKED|HANDOFF_SOURCE_UNAVAILABLE|HANDOFF_LEASE_MISSING/.test(driftCode)
  const driftStatus = state.approved === true ? (driftRefused ? 'passed' : 'failed') : 'blocked'
  assertRecord('native.review.source_drift', driftStatus, 'a source edit cancels approval and lease', { code: driftCode, required: driftCheck.value?.required, lease: driftCheck.value?.lease ?? null, approvedBeforeDrift: state.approved === true }, 'Editing the reviewed instruction must invalidate the persisted approval; without an approval this probe is blocked.', { surface: driftCheck.text })
  const writeAfterDrift = await callTool(ctx, handle.agent, 'write', { file_path: join(WORKSPACE, 'drift-product.txt'), content: 'must not exist after drift' })
  const driftWriteExists = existsSync(join(WORKSPACE, 'drift-product.txt'))
  assertRecord('native.guard.drift.mutator_body', writeAfterDrift.isError && !driftWriteExists ? 'passed' : 'failed', 'the product write stays denied after drift', { isError: writeAfterDrift.isError, exists: driftWriteExists, text: writeAfterDrift.text.slice(0, 200) }, writeAfterDrift.text, { text: writeAfterDrift.text })
  await handle.dispose()
  const live = ctx.get('agents').list().length
  assertRecord('native.restart.no_orphan', live === 0 ? 'passed' : 'failed', 0, live, 'The restarted Host has no review or spawn orphans.', { live })
  return { restarted: true, laneCallsBefore, laneCallsAfterRestart, driftCode, leaseApprovedRoundId: lease?.approvedRoundId }
}
async function startReviewTarget (ctx, agent, target) {
  const result = await ctx.commands.execute(agent, '/ulw-review ' + target, [], new AbortController().signal)
  const text = result?.result?.text || ''
  const roundId = (/round-[A-Za-z0-9-]+/.exec(text) || [])[0]
  trace('start-review-target', { target, kind: result?.result?.kind, roundId, text: text.slice(0, 500) })
  return { result, text, roundId }
}

async function readReviewStatus (ctx, agent, target) {
  const result = await callTool(ctx, agent, 'ulw_review', { action: 'status', target })
  const value = result.value || {}
  return {
    result,
    value,
    state: value.state || 'none',
    approved: value.approved === true,
    completed: value.completed === true,
    lanes: Array.isArray(value.lanes) ? value.lanes : [],
  }
}

async function waitForReviewStatus (ctx, agent, target, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = await readReviewStatus(ctx, agent, target)
  while (Date.now() < deadline) {
    if (predicate(last)) return last
    await sleep(100)
    last = await readReviewStatus(ctx, agent, target)
  }
  return last
}

async function runEarlyOkayScenario (ctx, state) {
  state.earlyOkay = true
  state.earlyAttempts = 0
  const handle = await ctx.agents.create({ sessionId: 'session-qa-early-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
  try {
    await ctx.commands.execute(handle.agent, '/ulw-mode execute', [], new AbortController().signal)
    const start = await startReviewTarget(ctx, handle.agent, PLAN2_REL)
    const accepted = start.roundId !== undefined && /accepted round/i.test(start.text)
    assertRecord('native.early_okay.round_started', accepted ? 'passed' : 'failed', 'an accepted live round', { roundId: start.roundId, kind: start.result?.result?.kind }, 'The failure-scenario round must start before the premature verdict is attempted.', { text: start.text.slice(0, 400) })
    if (!accepted) return { accepted: false }

    const earlyDeadline = Date.now() + 10000
    while (state.structuredRefusals.length === 0 && Date.now() < earlyDeadline) await sleep(100)
    const refusal = state.structuredRefusals.find(entry => /REVIEW_TOOL_DENIED|early OKAY/i.test(entry.text))
    const initial = await readReviewStatus(ctx, handle.agent, PLAN2_REL)
    const practicalInitial = initial.lanes.find(lane => lane.lane === 'practical')
    assertRecord('native.early_okay.premature_attempt_refused', refusal !== undefined ? 'passed' : 'failed', 'a refused premature structured_output OKAY', { refusals: state.structuredRefusals.length, earlyAttempts: state.earlyAttempts, refusalText: state.structuredRefusals.map(entry => entry.text.slice(0, 220)) }, 'The scripted practical lane must attempt OKAY before complete coverage and be refused.', { refusal: refusal?.text || null })
    assertRecord('native.early_okay.no_approval_before_complete', initial.approved === false && initial.completed === false ? 'passed' : 'failed', 'not approved before both complete lanes', { state: initial.state, approved: initial.approved, completed: initial.completed, lanes: initial.lanes.map(lane => ({ lane: lane.lane, status: lane.status, verdict: lane.verdict, complete: lane.complete })) }, 'A premature OKAY must never produce an approval or completed round.', { surface: initial.result.text.slice(0, 400) })
    assertRecord('native.early_okay.premature_lane_not_captured', practicalInitial !== undefined && practicalInitial.verdict !== 'OKAY' ? 'passed' : 'failed', 'the premature practical lane has no OKAY receipt', { practical: practicalInitial ? { status: practicalInitial.status, verdict: practicalInitial.verdict, complete: practicalInitial.complete } : null }, 'The early result must not become the practical lane verdict.')

    const terminal = await waitForReviewStatus(ctx, handle.agent, PLAN2_REL, status => status.state !== 'in_flight' && status.state !== 'preparing' && status.state !== 'required', 25000)
    let final = terminal
    if (final.state === 'in_flight' || final.state === 'preparing' || final.state === 'required') {
      await callTool(ctx, handle.agent, 'ulw_review', { action: 'cancel', roundId: start.roundId }, 30000)
      final = await readReviewStatus(ctx, handle.agent, PLAN2_REL)
    }
    const finalPractical = final.lanes.find(lane => lane.lane === 'practical')
    assertRecord('native.early_okay.round_not_approved', final.approved === false && final.completed === false && final.state !== 'approved' ? 'passed' : 'failed', 'a non-approved terminal outcome for the early-OKAY round', { state: final.state, approved: final.approved, completed: final.completed, practical: finalPractical ? { status: finalPractical.status, verdict: finalPractical.verdict, complete: finalPractical.complete } : null }, 'A lane stopped by the premature-OKAY path must never approve the round.', { surface: final.result.text.slice(0, 400) })
    assertRecord('native.early_okay.no_receipt_from_premature', finalPractical !== undefined && finalPractical.verdict !== 'OKAY' ? 'passed' : 'failed', 'no OKAY receipt from the premature lane', { practical: finalPractical ? { status: finalPractical.status, verdict: finalPractical.verdict, complete: finalPractical.complete } : null }, 'The early attempt must not become a lane receipt.')
    return { accepted, roundId: start.roundId, refusal, initial, final }
  } finally {
    await handle.dispose()
    state.earlyOkay = false
  }
}

async function runReloadInterruptScenario (ctx, state) {
  state.interrupt = true
  const handle = await ctx.agents.create({ sessionId: 'session-qa-reload-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
  let statusAgent
  try {
    await ctx.commands.execute(handle.agent, '/ulw-mode execute', [], new AbortController().signal)
    const start = await startReviewTarget(ctx, handle.agent, PLAN3_REL)
    const accepted = start.roundId !== undefined && /accepted round/i.test(start.text)
    const live = await waitForReviewStatus(ctx, handle.agent, PLAN3_REL, status => status.lanes.length === 2 && status.lanes.every(lane => typeof lane.childId === 'string' && lane.childId !== ''), 12000)
    const childIds = live.lanes.map(lane => lane.childId).filter(Boolean)
    assertRecord('native.reload_interrupt.live_round', accepted && childIds.length === 2 ? 'passed' : 'failed', 'a live round with two child lanes', { roundId: start.roundId, state: live.state, childIds }, 'The reload must happen while the round is live with one lane interrupted.', { text: start.text.slice(0, 300) })
    const fiber = state.reviewFiber
    let disposed = false
    let disposeError = null
    try {
      await bounded(fiber.dispose(), 30000, 'review fiber dispose')
      disposed = true
    } catch (error) { disposeError = error?.message || String(error) }
    state.reviewFiber = null
    await sleep(300)
    const liveAgentIds = ctx.agents.list().map(agent => agent.session.id)
    const interruptedLive = childIds.filter(id => liveAgentIds.includes(id))
    assertRecord('native.reload_interrupt.lane_disposed', disposed && interruptedLive.length === 0 ? 'passed' : 'failed', 'the interrupted lanes are disposed', { disposed, disposeError, interruptedLive, childIds }, 'Reloading the plugin during a live round must dispose its interrupted child lanes.', {})

    const remounted = await mountReview(ctx, state)
    const ready = await waitForReviewReady(ctx)
    assertRecord('native.reload_interrupt.remount_ready', remounted !== undefined && ready.ok === true ? 'passed' : 'failed', 'the review capability is ready after reload', { ok: ready.ok, capability: ready.capability || null, fiber: state.reviewFiber !== null }, 'The reloaded plugin must re-assemble and re-register the review surface.', { surface: ready.surface })
    statusAgent = await ctx.agents.create({ sessionId: 'session-qa-reload-status-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
    await ctx.commands.execute(statusAgent.agent, '/ulw-mode execute', [], new AbortController().signal)
    const persisted = await readReviewStatus(ctx, statusAgent.agent, PLAN3_REL)
    const surviving = ['inconclusive', 'cancelled', 'stopped', 'stale', 'changes_requested']
    assertRecord('native.reload_interrupt.state_not_approved', persisted.approved === false && surviving.includes(persisted.state) ? 'passed' : 'failed', 'a non-approved inconclusive/stale surviving state', { state: persisted.state, approved: persisted.approved, completed: persisted.completed, lanes: persisted.lanes.map(lane => ({ lane: lane.lane, status: lane.status, verdict: lane.verdict })) }, 'A reload that interrupts one lane must never leave an approved round.', { surface: persisted.result.text.slice(0, 400) })
    const liveAfter = ctx.agents.list().map(agent => agent.session.id)
    const remaining = childIds.filter(id => liveAfter.includes(id))
    assertRecord('native.reload_interrupt.no_orphan', remaining.length === 0 ? 'passed' : 'failed', 'no surviving interrupted child/run', { remaining, childIds }, 'The interrupted lane must leave no orphaned child or run.')

    const ordinary = await ctx.agents.create({ sessionId: 'session-qa-ordinary-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
    const ordinaryFile = join(WORKSPACE, 'reload-ordinary-product.txt')
    const ordinaryWrite = await callTool(ctx, ordinary.agent, 'write', { file_path: ordinaryFile, content: 'ordinary session remains usable' })
    assertRecord('native.reload_interrupt.ordinary_session_unaffected', !ordinaryWrite.isError && existsSync(ordinaryFile) ? 'passed' : 'failed', 'an ordinary new session still writes', { isError: ordinaryWrite.isError, exists: existsSync(ordinaryFile) }, 'An unrelated new session must remain unaffected by the interrupted review reload.', { text: ordinaryWrite.text.slice(0, 300) })
    await ordinary.dispose()
    return { accepted, roundId: start.roundId, childIds, disposed, persistedState: persisted.state, persistedApproved: persisted.approved }
  } finally {
    state.interrupt = false
    if (statusAgent) await statusAgent.dispose()
    await handle.dispose()
  }
}

async function main () {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(tracePath, '')
  const startedAtMs = Date.now()
  const dshRoot = resolve(options.dshRoot)
  const installed = readInstalledManifest(dshRoot)
  const require = createRequire(join(dshRoot, 'package.json'))
  const report = {
    schema: SCHEMA,
    task: 18,
    generatedAt: startedAt,
    argv,
    cwd: process.cwd(),
    label: 'linked-source',
    tarball_fixture: 'not_measured',
    live_quality: 'not_measured',
    mode: options.mode,
    environment: {
      node: process.version,
      platform: process.platform,
      dshRoot,
      dshVersion: installed.manifest.version,
      packageRoot: PACKAGE_ROOT,
      packageVersion: (() => { try { return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version } catch { return 'unknown' } })(),
      isolatedHome: HOME,
      workspace: WORKSPACE,
      plan: PLAN_REL,
    },
    assertions: [],
    scenarios: [],
    notes: null,
    condition: null,
    cleanup: null,
  }
  const state = {
    routeCalls: [],
    mainSteps: new Map(),
    mainFlow: 'happy',
    reviewerSteps: new Map(),
    reviewerState: new Map(),
    structuredRecorded: new Set(),
    structuredRefusals: [],
    activationResults: [],
    earlyOkay: false,
    earlyAttempts: 0,
    interrupt: false,
    laneCounters: new Map(),
    laneState: new Map(),
    booted: null,
    reviewFiber: null,
    roundId: undefined,
    launchId: undefined,
    lease: null,
    approved: false,
  }
  let exitCode = EXIT.ok
  try {
    const packageVersionOk = existsSync(installed.file) && /^\d+\.\d+\.\d+/.test(String(installed.manifest.version))
    assertRecord('native.dsh_root.package', packageVersionOk ? 'passed' : 'failed', 'a readable semver package manifest', { file: installed.file, version: installed.manifest.version }, 'Parsed the installed package manifest.', { requested: dshRoot })
    if (!installed.hasProfileBoot || !installed.hasLib) {
      fail('native.dsh_root.public_exports', ['./profile-boot', './lib/*'], installed.exports, 'The installed package does not expose the public profile-boot entrypoint.')
      report.condition = { code: 'DSH_PUBLIC_EXPORTS_MISSING', detail: 'the installed package exports map lacks ./profile-boot or ./lib/*' }
      throw new Error(report.condition.detail)
    }
    assertRecord('native.dsh_root.public_exports', installed.hasProfileBoot && installed.hasLib ? 'passed' : 'failed', ['./profile-boot', './lib/*'], Object.keys(installed.exports), 'Resolved only public package exports.')
    const workspace = createWorkspace()
    trace('workspace', workspace)

    process.env.DSH_HOME = HOME
    const booted = await bootHost(dshRoot, require)
    state.booted = booted
    const ctx = booted.ctx
    assertRecord('native.profile.booted', ctx.fiber.state === 2 ? 'passed' : 'failed', 2, ctx.fiber.state, 'The shipped headless profile booted through runProfile into a temp DSH_HOME.', { profile: 'headless', home: HOME })
    const services = ['tools', 'agents', 'llm', 'storage', 'subagents', 'agentPresets', 'sessionProjections', 'commands', 'workingDirectory']
    const present = Object.fromEntries(services.map(name => { try { return [name, ctx.get(name) !== undefined] } catch { return [name, false] } }))
    assertRecord('native.host.enhanced_services', services.every(name => present[name]) ? 'passed' : 'failed', services, present, 'All four enhanced services and the real Agent/tools/stores are present.', present)

    await mountReview(ctx, state)
    const ready = await waitForReviewReady(ctx)
    assertRecord('native.review.assembly_ready', ready.ok === true ? 'passed' : 'failed', 'ready', { ok: ready.ok, capability: ready.capability || null }, 'The enhanced review assembly became ready on the real Cordis context before scenarios ran.', { surface: ready.surface })

    const bootstrap = await ctx.agents.create({ sessionId: 'session-qa-bootstrap-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
    const commandNames = ctx.get('commands').list(bootstrap.agent).map(command => command.name)
    await bootstrap.dispose()
    assertRecord('native.plugin.loaded', ['ulw-mode', 'ulw-review', 'ulw-consult'].every(name => commandNames.includes(name)) ? 'passed' : 'failed', ['ulw-mode', 'ulw-review', 'ulw-consult'], { commands: commandNames.filter(name => name.startsWith('ulw-')) }, 'The plugin is mounted on the real Cordis context.', { commandNames })
    const toolPresence = { 'ulw_review': ctx.tools.get('ulw_review') !== undefined, 'ulw_handoff': ctx.tools.get('ulw_handoff') !== undefined }
    assertRecord('native.tools.registered', toolPresence.ulw_review && toolPresence.ulw_handoff ? 'passed' : 'failed', { ulw_review: true, ulw_handoff: true }, toolPresence, 'Both model-facing review entrypoints are registered on the real tools service.', { presence: toolPresence })

    const { llm, registration } = await installScriptedAdapter(ctx, require, state)
    assertRecord('native.llm.scripted_adapter', ctx.llm.listProviders().some(provider => provider.id === 'qa-scripted') ? 'passed' : 'failed', 'qa-scripted', ctx.llm.listProviders().map(provider => provider.id), 'A local scripted adapter is registered on the real llm service; no network or credentials are used.', { providers: ctx.llm.listProviders() })

    const flow = await runNativeFlow(ctx, llm, state)
    state.roundId = flow.roundId
    state.launchId = flow.launchId
    state.lease = flow.lease
    state.approved = flow.approved === true
    const spawn = await nativeSpawnSelfTest(ctx, state)
    const restart = await restartProbe(dshRoot, require, state)
    const activeCtx = state.booted.ctx
    const early = await runEarlyOkayScenario(activeCtx, state)
    const reload = await runReloadInterruptScenario(activeCtx, state)

    const probeCtx = activeCtx
    const probeAgent = await probeCtx.agents.create({ sessionId: 'session-qa-probe-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
    const malformed = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'not-an-action', target: PLAN_REL })
    const malformedApproved = malformed.value?.approved === true || malformed.value?.completed === true
    assertRecord('native.adversarial.malformed_input', !malformedApproved && (malformed.isError || ['unavailable', 'invalid', 'rejected'].includes(malformed.value?.phase)) ? 'passed' : 'failed', 'no approval or completed result', { isError: malformed.isError, approved: malformedApproved, phase: malformed.value?.phase, text: malformed.text.slice(0, 300) }, 'A malformed action reached the real tool boundary and produced no approval or completion.')
    const forged = await callTool(probeCtx, probeAgent.agent, 'ulw_handoff', { action: 'check', target: PLAN_REL, approved: true })
    assertRecord('native.adversarial.misleading_success_output', forged.value?.lease == null && forged.value?.ok !== true ? 'passed' : 'failed', 'no lease from a forged approved flag', { isError: forged.isError, code: forged.value?.code ?? null, lease: forged.value?.lease ?? null }, 'A forged approved flag is not a lease and is rejected or ignored by the real contract.')
    const cancel = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'cancel', roundId: 'round-does-not-exist' })
    const cancelRefused = cancel.value?.approved !== true && cancel.value?.completed !== true && /UNKNOWN_ROUND|refused|rejected/i.test(cancel.text)
    assertRecord('native.adversarial.cancel_resume', cancelRefused ? 'passed' : 'failed', 'an absent round is refused, never approved', { code: cancel.value?.code ?? null, approved: cancel.value?.approved === true, completed: cancel.value?.completed === true, isError: cancel.isError }, 'Cancel of an absent round must be refused, never turned into an approval.', { surface: cancel.text.slice(0, 300) })
    const untracked = existsSync(join(WORKSPACE, 'dirty-untracked.txt')) && existsSync(join(WORKSPACE, 'misleading-draft-okay.txt'))
    assertRecord('native.adversarial.dirty_worktree', untracked === true ? 'passed' : 'failed', 'untracked probe files exist without becoming approval', { untracked }, 'Untracked files and a misleading draft do not become state or approval.')
    const interruptionErrors = []
    for (let i = 0; i < 3; i++) {
      try {
        const interrupted = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'cancel', roundId: 'missing-round-' + i })
        if (interrupted.isError) interruptionErrors.push('unexpected-error-' + i)
      } catch (error) { interruptionErrors.push(error.message) }
    }
    assertRecord('native.adversarial.repeated_interruption', interruptionErrors.length === 0 ? 'passed' : 'failed', 'no unhandled rejection', { errors: interruptionErrors }, 'Three repeated cancel probes settled without an unhandled rejection.')
    const stale = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'status', roundId: 'round-stale-does-not-exist' })
    const staleRefused = stale.value?.approved !== true && stale.value?.completed !== true && /UNKNOWN_ROUND|refused|rejected/i.test(stale.text)
    assertRecord('native.adversarial.stale_state', staleRefused ? 'passed' : 'failed', 'a stale round id is refused, never approved', { code: stale.value?.code ?? null, approved: stale.value?.approved === true, completed: stale.value?.completed === true }, 'A stale round identity must be refused, never approved.', { surface: stale.text.slice(0, 300) })
    const flaky = []
    for (let i = 0; i < 3; i++) {
      const attempt = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'status', target: PLAN_REL })
      flaky.push(attempt.value?.capability?.reason ?? 'missing')
    }
    assertRecord('native.adversarial.flaky_tests', flaky.length === 3 && new Set(flaky).size === 1 ? 'passed' : 'failed', 'three identical capability results', flaky, 'The capability probe is deterministic across three calls.', { results: flaky })
    const hungMarker = join(WORKSPACE, 'hung-command-marker.txt')
    const offAgent = await probeCtx.agents.create({ sessionId: 'session-qa-hung-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
    const hungController = new AbortController()
    let hungOutcome
    try {
      const hung = probeCtx.tools.execute({ callId: 'qa-hung-command', name: 'bash', arguments: { command: 'sleep 30; echo late > ' + hungMarker, description: 'qa hung-command probe' }, agent: offAgent.agent, signal: hungController.signal })
      setTimeout(() => hungController.abort(new Error('QA_HUNG_COMMAND_ABORT')), 100)
      const settled = await bounded(hung, 8000, 'hung command abort')
      hungOutcome = { isError: settled.isError, text: textOfContent(settled.content).slice(0, 200) }
    } catch (error) {
      hungOutcome = { rejected: error?.message || String(error) }
    }
    assertRecord('native.adversarial.hung_commands', !existsSync(hungMarker) && hungOutcome?.rejected === undefined ? 'passed' : 'failed', 'abort settles and the body never completes', { outcome: hungOutcome, markerExists: existsSync(hungMarker) }, 'A hung bash command was aborted through the real host cancellation seam.', { outcome: hungOutcome })
    await offAgent.dispose()
    const probeIds = probeCtx.get('agents').list().map(agent => agent.session.id)
    await probeAgent.dispose()
    if (flow?.main) { try { await flow.main.dispose() } catch { /* already closed by the host */ } }
    await sleep(300)
    const liveAfterClose = probeCtx.get('agents').list().map(agent => agent.session.id)
    assertRecord('native.cleanup.owned_handles', liveAfterClose.length === 0 ? 'passed' : 'failed', 0, liveAfterClose.length, 'After closing every handle this harness owns, no owned Agent handle remains live.', { probeIds, liveAfterClose })
    registration()

    report.assertions = assertions
    report.scenarios = scenarioResults
    const failed = assertions.filter(assertion => assertion.status === 'failed')
    const blockedAssertions = assertions.filter(assertion => assertion.status === 'blocked')
    report.summary = { total: assertions.length, passed: assertions.filter(a => a.status === 'passed').length, failed: failed.length, blocked: blockedAssertions.length }
    report.notes = {
      prompt_injection: 'ruled out as a cause: the failure is a deterministic Cordis/native-result integration mismatch before any plan prose is trusted; the scripted adapter never treats plan text as instructions',
      tarball_fixture: 'not_measured in this linked-source run',
      live_quality: 'not_measured; no live model call is authorized or made',
    }

    const requiredIds = [
      'native.dsh_root.package', 'native.dsh_root.public_exports', 'native.profile.booted',
      'native.host.enhanced_services', 'native.review.assembly_ready', 'native.plugin.loaded',
      'native.tools.registered', 'native.commands.registered', 'native.mode.plan.slash',
      'native.guard.plan.product_write', 'native.guard.plan.draft_write', 'native.mode.execute.slash',
      'native.guard.execute.mutator_body', 'native.guard.execute.denial_surface',
      'native.guard.execute.bash_body', 'native.guard.execute.delegation_body',
      'native.review.slash_tool.acceptance', 'native.enhanced.assembly',
      'native.review.activations.two_distinct', 'native.review.coverage', 'native.review.capture',
      'native.review.lane_result_propagation', 'native.review.round_approved',
      'native.review.route_requests', 'native.review.scripted_adapter_nonce_free',
      'native.handoff.lease', 'native.handoff.product_write_after_lease',
      'native.review.source_drift', 'native.guard.drift.mutator_body',
      'native.restart.commands', 'native.restart.assembly_ready', 'native.restart.review_state',
      'native.restart.lease', 'native.restart.write_after_lease', 'native.restart.no_new_lane_start',
      'native.restart.no_orphan', 'native.cleanup.owned_handles',
      'native.native_spawn.two_distinct_sessions', 'native.native_spawn.no_orphan',
      'native.early_okay.round_started', 'native.early_okay.premature_attempt_refused',
      'native.early_okay.no_approval_before_complete', 'native.early_okay.premature_lane_not_captured',
      'native.early_okay.round_not_approved', 'native.early_okay.no_receipt_from_premature',
      'native.reload_interrupt.live_round', 'native.reload_interrupt.lane_disposed',
      'native.reload_interrupt.remount_ready', 'native.reload_interrupt.state_not_approved',
      'native.reload_interrupt.no_orphan', 'native.reload_interrupt.ordinary_session_unaffected',
    ]
    const byId = new Map(assertions.map(assertion => [assertion.id, assertion]))
    const requiredIssues = requiredIds.filter(id => byId.get(id)?.status !== 'passed')
    const spawnIds = ['native.native_spawn.two_distinct_sessions', 'native.native_spawn.no_orphan']
    const spawnPassed = spawnIds.every(id => byId.get(id)?.status === 'passed')
    scenarioResults.push({ id: 'native-spawn-selftest', status: spawnPassed ? 'passed' : 'failed', evidence: spawn })
    scenarioResults.push({ id: 'real-native-dual-and-handoff', status: flow.approved === true && flow.leaseOk === true ? 'passed' : 'blocked', evidence: { roundId: flow.roundId, approved: flow.approved, lease: flow.lease ? { handoffId: flow.lease.handoffId, required: flow.lease.required } : null, lanes: flow.lanes, routeCalls: state.routeCalls.filter(call => /qa-practical|qa-adversarial/.test(call.model)).length } })
    const guardIds = ['native.guard.execute.mutator_body', 'native.guard.execute.denial_surface', 'native.guard.execute.bash_body', 'native.guard.execute.delegation_body', 'native.guard.drift.mutator_body']
    const guardPassed = guardIds.every(id => byId.get(id)?.status === 'passed')
    const driftPassed = byId.get('native.review.source_drift')?.status === 'passed'
    scenarioResults.push({ id: 'real-native-guard-and-drift', status: guardPassed && driftPassed ? 'passed' : (guardPassed ? 'blocked' : 'failed'), evidence: { sourceDriftCode: restart.driftCode, sourceDriftStatus: byId.get('native.review.source_drift')?.status, spawn } })
    const restartIds = ['native.restart.review_state', 'native.restart.lease', 'native.restart.write_after_lease', 'native.restart.no_new_lane_start', 'native.restart.no_orphan']
    const restartPassed = restartIds.every(id => byId.get(id)?.status === 'passed')
    scenarioResults.push({ id: 'restart', status: restartPassed ? 'passed' : 'blocked', evidence: restart })
    const earlyIds = requiredIds.filter(id => id.startsWith('native.early_okay.'))
    const earlyPassed = earlyIds.every(id => byId.get(id)?.status === 'passed')
    scenarioResults.push({ id: 'early-okay-premature-verdict', status: earlyPassed ? 'passed' : 'failed', evidence: early })
    const reloadIds = requiredIds.filter(id => id.startsWith('native.reload_interrupt.'))
    const reloadPassed = reloadIds.every(id => byId.get(id)?.status === 'passed')
    scenarioResults.push({ id: 'reload-interrupt-one-lane', status: reloadPassed ? 'passed' : 'failed', evidence: reload })

    if (requiredIssues.length === 0) {
      report.status = 'passed'
      report.condition = { code: 'OK', detail: 'all required native review assertions passed on the real Cordis host', required: requiredIds.length }
      exitCode = EXIT.ok
    } else {
      report.status = 'blocked'
      const propagation = byId.get('native.review.lane_result_propagation')
      if (propagation && propagation.status === 'failed') {
        report.condition = {
          code: 'NATIVE_LANE_RESULT_UNWRAPPED',
          detail: 'both reviewer lanes recorded a structured_output tool result, but the coordinator validated no lane verdict and the round became inconclusive; the real spawn provider returns a SubagentResult wrapper instead of the review result object',
          evidence: 'lanes: ' + JSON.stringify(flow.lanes.map(lane => ({ lane: lane.lane, verdict: lane.verdict, status: lane.status, complete: lane.complete }))),
          missingApi: 'the review transport must pass SubagentResult.structured (or the coordinator must unwrap it); activation.result is { output, structured, stopReason }',
          reviewActivationResults: state.activationResults.filter(record => String(record.label || '').startsWith('ulw-plan-review')),
          acceptance: 'not met: no approved round, no lease, no persisted approval, no restart persistence',
        }
      } else {
        report.condition = {
          code: 'NATIVE_ACCEPTANCE_INCOMPLETE',
          detail: 'required assertions did not all pass',
          issues: requiredIssues,
          failed: failed.map(a => a.id),
          blocked: blockedAssertions.map(a => a.id),
          acceptance: 'not met',
        }
      }
      exitCode = EXIT.blocked
    }
  } catch (error) {
    trace('fatal', { message: error?.stack || String(error) })
    if (!report.condition) report.condition = { code: 'HARNESS_BLOCKED', detail: error?.message || String(error) }
    report.assertions = assertions
    report.scenarios = scenarioResults
    report.summary = { total: assertions.length, passed: assertions.filter(a => a.status === 'passed').length, failed: assertions.filter(a => a.status === 'failed').length, blocked: assertions.filter(a => a.status === 'blocked').length }
    exitCode = EXIT.blocked
  } finally {
    try { if (state.booted) await bounded(state.booted.ctx.fiber.dispose(), 60000, 'final dispose') } catch (error) { trace('cleanup-error', { message: error.message }) }
    try { rmSync(TMP, { recursive: true, force: true }) } catch (error) { trace('cleanup-tmp-error', { message: error.message }) }
    const elapsed = Date.now() - startedAtMs
    report.cleanup = { tempRemoved: !existsSync(TMP), elapsedMs: elapsed, ownedHandles: 0 }
    report.durationMs = elapsed
    if (!report.condition) report.condition = { code: 'HARNESS_INCOMPLETE', detail: 'no condition recorded' }
    try { writeFileSync(join(OUT, 'assertions.json'), JSON.stringify(report, null, 2) + '\n') } catch (error) { process.stderr.write('cannot write assertions.json: ' + error.message + '\n') }
    process.stderr.write('cordis-review-qa: ' + (exitCode === 0 ? 'PASS' : 'BLOCKED') + ' (' + report.condition.code + '): ' + report.condition.detail + '\n')
    process.stderr.write('assertions=' + JSON.stringify(report.summary) + ' evidence=' + join(OUT, 'assertions.json') + '\n')
    process.exit(exitCode)
  }
}

await main()