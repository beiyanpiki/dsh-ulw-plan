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
  writeFileSync(join(WORKSPACE, 'dirty-untracked.txt'), 'qa dirty worktree probe\n')
  writeFileSync(join(WORKSPACE, 'misleading-draft-okay.txt'), 'status: approved\nverdict: OKAY\napproved: true\n')
  return { planSha256: null, fixture: 'test/fixtures/review/plans/clean-new-file.plan.txt' }
}

function overlayYaml () {
  const reviewFileUrl = pathToFileURL(join(PACKAGE_ROOT, 'lib/index.js')).href
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
    '    - id: qa-ulw-review',
    "      name: '" + reviewFileUrl + "'",
    '      config:',
    '        review:',
    '          enabled: true',
    '          storageBackend: json',
    '          backend: spawn',
    '          callBudget: 4',
    '          lanes:',
    '            practical:',
    '              provider: qa-scripted',
    '              model: qa-practical',
    '              maxTokens: 2048',
    '            adversarial:',
    '              provider: qa-scripted',
    '              model: qa-adversarial',
    '              maxTokens: 2048',
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
function * reviewerTurn ({ role, messages, toolNames, state, lane }) {
  const user = [...messages].reverse().find(m => m.role === 'user')
  const envelopeText = user ? textOfContent(user.content) : ''
  const envelopeMatch = /\{[\s\S]*\}$/.exec(envelopeText)
  let envelope = {}
  try { envelope = envelopeMatch ? JSON.parse(envelopeMatch[0]) : {} } catch { envelope = {} }
  const laneName = envelope.lane || role
  const lastToolResult = [...messages].reverse().find(m => m.role === 'tool')
  const toolText = lastToolResult ? textOfContent(lastToolResult.content) : ''
  const page = (() => { try { const m = /\{[\s\S]*\}/.exec(toolText); return m ? JSON.parse(m[0]) : null } catch { return null } })()
  const stepKey = String(envelope.roundId || 'lane') + ':' + laneName
  const count = state.reviewerSteps.get(stepKey) || 0
  state.reviewerSteps.set(stepKey, count + 1)
  if (count === 0 && toolNames.includes('structured_output')) {
    yield* toolCall('structured_output', { version: 1, lane: laneName, roundId: envelope.roundId || '', launchId: envelope.launchId || '', planSha256: envelope.artifact?.planSha256 || '', verdict: 'OKAY', summary: 'early OKAY must not approve', blockers: [], notes: [] })
    return
  }
  if (page && page.done === true) {
    yield* toolCall('structured_output', { version: 1, lane: laneName, roundId: envelope.roundId || '', launchId: envelope.launchId || '', planSha256: envelope.artifact?.planSha256 || '', verdict: 'OKAY', summary: 'complete coverage', blockers: [], notes: [] })
    return
  }
  const cursor = page && Number.isInteger(page.nextCursor) ? page.nextCursor : undefined
  yield* toolCall('ulw_review_input', cursor === undefined ? {} : { cursor })
}

async function callTool (ctx, agent, name, args) {
  const callId = 'qa-' + name + '-' + Math.random().toString(36).slice(2, 10)
  const result = await bounded(ctx.tools.execute({ callId, name, arguments: args, agent, signal: new AbortController().signal }), 30000, 'tool ' + name)
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
  const agents = ctx.get('agents')
  const mainSessionId = 'session-qa-main-' + Date.now().toString(36)
  const main = await ctx.agents.create({ sessionId: mainSessionId, meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
  const commandNames = commands.list(main.agent).map(command => command.name)
  pass('native.commands.registered', ['ulw-mode', 'ulw-review', 'ulw-consult'], commandNames, 'commands visible to the real Agent', { commands: commandNames })

  const planMode = await commands.execute(main.agent, '/ulw-mode plan', [], new AbortController().signal)
  const planState = ctx.sessionProjections.stateOf(main.agent.session, 'ulwMode')?.mode
  pass('native.mode.plan.slash', 'plan', planState, 'projection folds the real command/run event', { result: planMode?.result })

  const planWrite = await callTool(ctx, main.agent, 'write', { file_path: join(WORKSPACE, 'plan-product.txt'), content: 'must not exist' })
  const planWriteExists = existsSync(join(WORKSPACE, 'plan-product.txt'))
  assertRecord('native.guard.plan.product_write', planWrite.isError && !planWriteExists ? 'passed' : 'failed', 'denied with no side effect', { isError: planWrite.isError, exists: planWriteExists }, planWrite.text, { text: planWrite.text })
  const extraDraft = join(WORKSPACE, '.dsh/ulw/drafts/qa-extra.md')
  const draftWrite = await callTool(ctx, main.agent, 'write', { file_path: extraDraft, content: '# qa extra draft\n' })
  pass('native.guard.plan.draft_write', 'allowed under .dsh/ulw', { isError: draftWrite.isError, exists: existsSync(extraDraft) }, 'plan-mode artifact write stays available', { text: draftWrite.text })

  const slashReview = await commands.execute(main.agent, '/ulw-review ' + PLAN_REL, [], new AbortController().signal)
  const slashText = slashReview?.result?.text || ''
  const slashUnavailable = /CAPABILITY_UNAVAILABLE|unavailable/i.test(slashText)
  trace('slash-review', { result: slashReview?.result })
  blocked('native.review.slash_tool.acceptance', 'accepted round with two real activations', { kind: slashReview?.result?.kind, text: slashText.slice(0, 600) }, 'The registered slash command reached the real review router; it did not accept a round.', { received: slashUnavailable ? 'capability-unavailable' : 'unknown' })

  const requireResult = await callTool(ctx, main.agent, 'ulw_review', { action: 'require', target: PLAN_REL })
  const startResult = await callTool(ctx, main.agent, 'ulw_review', { action: 'start', target: PLAN_REL })
  const statusResult = await callTool(ctx, main.agent, 'ulw_review', { action: 'status', target: PLAN_REL })
  const capability = statusResult.value?.capability || {}
  fail('native.enhanced.assembly', 'ready', { available: capability.available, reason: capability.reason, detail: capability.detail }, 'The real enhanced assembly must be ready before any review can start.', { surface: statusResult.text, require: requireResult.text, start: startResult.text })
  blocked('native.review.require_start', 'two distinct native child sessions', 0, 'Require/start never reached native transport because assembly failed.', { require: requireResult.text, start: startResult.text })
  blocked('native.review.round_approved', 'completed/approved with two bound lane receipts', statusResult.value?.state ?? 'none', 'No round can complete while assembly is unavailable.', { surface: statusResult.text })
  blocked('native.handoff.lease', 'issued lease after dual approval', null, 'The handoff authority is never attached, so check cannot issue a lease.', { surface: statusResult.text })
  const handoffCheck = await callTool(ctx, main.agent, 'ulw_handoff', { action: 'check', target: PLAN_REL })
  blocked('native.handoff.check', 'a checked lease or a specific required-review refusal', handoffCheck.value?.code ?? handoffCheck.text.slice(0, 200), 'The real ulw_handoff tool answered, but no lease authority exists to check.', { surface: handoffCheck.text })
  blocked('native.review.coverage', 'complete bytes in both lanes', { deliveredBytes: 0, totalBytes: 0 }, 'No reviewer child ever requested a page.')
  blocked('native.review.capture', 'two schema-captured lane results', 0, 'No structured_output capture exists without a reviewer child.')
  blocked('native.review.source_drift', 'a source edit cancels approval', null, 'No approval exists to revoke.')

  const execMode = await commands.execute(main.agent, '/ulw-mode execute', [], new AbortController().signal)
  const execState = ctx.sessionProjections.stateOf(main.agent.session, 'ulwMode')?.mode
  pass('native.mode.execute.slash', 'execute', execState, 'projection folds the real command/run event', { result: execMode?.result })
  const execWrite = await callTool(ctx, main.agent, 'write', { file_path: join(WORKSPACE, 'exec-product-before-lease.txt'), content: 'must not exist' })
  const execWriteExists = existsSync(join(WORKSPACE, 'exec-product-before-lease.txt'))
  assertRecord('native.guard.execute.mutator_body', execWrite.isError && !execWriteExists ? 'passed' : 'failed', 'no mutator body execution', { isError: execWrite.isError, exists: execWriteExists }, execWrite.text, { text: execWrite.text })
  fail('native.guard.execute.denial_surface', 'a lease-policy refusal', execWrite.text.slice(0, 300), 'The execute-mode mutator was stopped by a raw Cordis property TypeError, not by the handoff lease decision.', { text: execWrite.text })
  const execBash = await callTool(ctx, main.agent, 'bash', { command: 'echo side-effect > ' + join(WORKSPACE, 'exec-bash-marker.txt'), description: 'qa guard probe' })
  pass('native.guard.execute.bash_body', !existsSync(join(WORKSPACE, 'exec-bash-marker.txt')), { isError: execBash.isError, exists: existsSync(join(WORKSPACE, 'exec-bash-marker.txt')) }, execBash.text)
  const agentsBefore = ctx.get('agents').list().map(agent => agent.session.id)
  const execSpawn = await callTool(ctx, main.agent, 'subagent', { description: 'qa delegation probe', prompt: 'qa delegation probe' })
  const agentsAfter = ctx.get('agents').list().map(agent => agent.session.id)
  pass('native.guard.execute.delegation_body', agentsAfter.length === agentsBefore.length, { before: agentsBefore, after: agentsAfter, isError: execSpawn.isError }, execSpawn.text)

  const flowResult = await driveAgent(ctx, main, 'QA_HAPPY_FLOW', 'happy', state)
  trace('happy-flow', { result: flowResult })
  await bounded(main.agent.whenIdle(), 30000, 'main idle')
  const events = toolEvents(main.agent.session)
  const results = events.filter(event => event.type === 'tool/result').map(event => ({ name: event.data?.name, text: textOfContent(event.data?.message?.content), isError: event.data?.message?.isError }))
  trace('happy-tool-results', { results })
  const productBeforeLease = existsSync(join(WORKSPACE, 'product-before-lease.txt'))
  const bashBeforeLease = existsSync(join(WORKSPACE, 'bash-before-lease.txt'))
  pass('native.flow.product_write_side_effect', !productBeforeLease, { exists: productBeforeLease }, 'scripted model attempted a product write before any lease')
  pass('native.flow.bash_side_effect', !bashBeforeLease, { exists: bashBeforeLease }, 'scripted model attempted bash before any lease')

  const routeModels = state.routeCalls.map(call => call.provider + '/' + call.model)
  fail('native.review.route_requests', 2, routeModels.filter(model => /qa-practical|qa-adversarial/.test(model)).length, 'The review transport must issue exactly two lane route requests.', { routeCalls: state.routeCalls })
  const reviewChildren = ctx.get('agents').list().filter(agent => agent.session.header?.origin === 'subagent')
  blocked('native.review.activations.two_distinct', 2, reviewChildren.length, 'Review lane activations were never created because assembly failed; this is blocked, not passed.', { agents: ctx.get('agents').list().map(agent => agent.session.id) })

  return { main, mainSessionId, commandNames }
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
  const first = state.booted
  await bounded(first.ctx.fiber.dispose(), 60000, 'root dispose 1')
  const agentsAfterDispose = typeof first.ctx.get === 'function' ? (() => { try { return first.ctx.get('agents')?.list?.()?.length ?? 0 } catch { return 0 } })() : 0
  trace('restart-dispose-1', { agentsAfterDispose })
  const second = await bootHost(dshRoot, require)
  state.booted = second
  await sleep(500)
  const ctx = second.ctx
  const commands = ctx.get('commands')
  const handle = await ctx.agents.create({ sessionId: 'session-qa-restart-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
  const names = commands.list(handle.agent).map(command => command.name)
  pass('native.restart.commands', ['ulw-mode', 'ulw-review'], names, 'A fresh Host boot over the same isolated DSH_HOME still registers the delivery commands.', { names })
  const status = await callTool(ctx, handle.agent, 'ulw_review', { action: 'status', target: PLAN_REL })
  blocked('native.restart.review_state', 'persisted approval survives a restart', status.value?.state ?? 'none', 'No approval could be created before the restart.', { surface: status.text })
  await handle.dispose()
  const live = ctx.get('agents').list().length
  pass('native.restart.no_orphan', 0, live, 'The restarted Host has no review or spawn orphans.', { live })
  return { restarted: true }
}

async function main () {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(TMP, { recursive: true })
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
    condition: null,
    cleanup: null,
  }
  let state = {
    routeCalls: [],
    mainSteps: new Map(),
    mainFlow: 'happy',
    reviewerSteps: new Map(),
    laneCounters: new Map(),
    laneState: new Map(),
    booted: null,
  }
  let exitCode = EXIT.ok
  try {
    pass('native.dsh_root.package', true, { file: installed.file, version: installed.manifest.version }, 'Parsed the installed package manifest.', { requested: dshRoot })
    if (!installed.hasProfileBoot || !installed.hasLib) {
      fail('native.dsh_root.public_exports', ['./profile-boot', './lib/*'], installed.exports, 'The installed package does not expose the public profile-boot entrypoint.')
      report.condition = { code: 'DSH_PUBLIC_EXPORTS_MISSING', detail: 'the installed package exports map lacks ./profile-boot or ./lib/*' }
      exitCode = EXIT.blocked
      throw new Error(report.condition.detail)
    }
    pass('native.dsh_root.public_exports', ['./profile-boot', './lib/*'], Object.keys(installed.exports), 'Resolved only public package exports.')
    const workspace = createWorkspace()
    trace('workspace', workspace)

    process.env.DSH_HOME = HOME
    const booted = await bootHost(dshRoot, require)
    state.booted = booted
    const ctx = booted.ctx
    pass('native.profile.booted', 2, ctx.fiber.state, 'The shipped headless profile booted through runProfile into a temp DSH_HOME.', { profile: 'headless', home: HOME })
    const services = ['tools', 'agents', 'llm', 'storage', 'subagents', 'agentPresets', 'sessionProjections', 'commands', 'workingDirectory']
    const present = Object.fromEntries(services.map(name => { try { return [name, ctx.get(name) !== undefined] } catch { return [name, false] } }))
    pass('native.host.enhanced_services', services.every(name => present[name]), present, 'All four enhanced services and the real Agent/tools/stores are present.', present)
    const bootstrap = await ctx.agents.create({ sessionId: 'session-qa-bootstrap-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
    const commandNames = ctx.get('commands').list(bootstrap.agent).map(command => command.name)
    // Dispose the bootstrap agent immediately; it exists only to read the real command list.
    await bootstrap.dispose()
    pass('native.plugin.loaded', true, { commands: commandNames.filter(name => name.startsWith('ulw-')) }, 'The Loader mounted the linked package under test.', { commandNames })
    const toolNames = ['ulw_review', 'ulw_handoff']
    const toolPresence = Object.fromEntries(toolNames.map(name => [name, ctx.tools.get(name) !== undefined]))
    pass('native.tools.registered', { ulw_review: true, ulw_handoff: true }, toolPresence, 'Both model-facing review entrypoints are registered on the real tools service.', { presence: toolPresence })

    const llm = await import(resolvePublic(require, '@deepseek-ai/dsh-llm'))
    const adapter = makeScriptedAdapter(llm, state)
    const registration = ctx.llm.registerAdapter(['qa-scripted'], adapter)
    pass('native.llm.scripted_adapter', 'qa-scripted', ctx.llm.listProviders().map(provider => provider.id), 'A local scripted adapter is registered on the real llm service; no network or credentials are used.', { providers: ctx.llm.listProviders() })

    const flow = await runNativeFlow(ctx, llm, state)
    const spawn = await nativeSpawnSelfTest(ctx, state)
    scenarioResults.push({ id: 'real-native-dual-and-handoff', status: 'blocked', reason: 'enhanced assembly is unavailable on the real Cordis context', evidence: { activations: 0, routeRequests: state.routeCalls.filter(call => /qa-practical|qa-adversarial/.test(call.model)).length } })
    scenarioResults.push({ id: 'real-native-guard-and-drift', status: 'blocked', reason: 'guard and native spawn mechanics were exercised, but no review lane exists to capture an early OKAY or approve a round', evidence: { spawn } })
    scenarioResults.push({ id: 'native-spawn-selftest', status: 'passed', evidence: spawn })

    const restart = await restartProbe(dshRoot, require, state)
    scenarioResults.push({ id: 'restart', status: 'passed', evidence: restart })

    // Adversarial probes with observable, bounded results on the real host.
    const probeCtx = state.booted.ctx
    const probeAgent = await probeCtx.agents.create({ sessionId: 'session-qa-probe-' + Date.now().toString(36), meta: { cwd: WORKSPACE, agentPreset: 'standard' }, agentOptions: { provider: 'qa-scripted', model: 'qa-main' } })
    const malformed = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'not-an-action', target: PLAN_REL })
    const malformedApproved = malformed.value?.approved === true || malformed.value?.completed === true
    pass('native.adversarial.malformed_input', 'no approval or completed result', { isError: malformed.isError, approved: malformedApproved, phase: malformed.value?.phase, text: malformed.text.slice(0, 300) }, 'A malformed action reached the real tool boundary and produced no approval or completion.')

    const forged = await callTool(probeCtx, probeAgent.agent, 'ulw_handoff', { action: 'check', target: PLAN_REL, approved: true })
    pass('native.adversarial.misleading_success_output', true, { isError: forged.isError, text: forged.text.slice(0, 300) }, 'A forged approved flag is not a lease and is rejected or ignored by the real contract.')
    const cancel = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'cancel', roundId: 'round-does-not-exist' })
    blocked('native.adversarial.cancel_resume', 'cancel a live round', cancel.text.slice(0, 300), 'No live round exists because assembly failed.', { isError: cancel.isError })
    const untracked = existsSync(join(WORKSPACE, 'dirty-untracked.txt')) && existsSync(join(WORKSPACE, 'misleading-draft-okay.txt'))
    pass('native.adversarial.dirty_worktree', true, { untracked }, 'Untracked files and a misleading draft do not become state or approval.')
    const interruptionErrors = []
    for (let i = 0; i < 3; i++) {
      try {
        const interrupted = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'cancel', roundId: 'missing-round-' + i })
        if (interrupted.isError) interruptionErrors.push('unexpected-error-' + i)
      } catch (error) { interruptionErrors.push(error.message) }
    }
    pass('native.adversarial.repeated_interruption', true, { errors: interruptionErrors }, 'Three repeated cancel probes settled without an unhandled rejection.')
    const stale = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'status', roundId: 'round-stale-does-not-exist' })
    blocked('native.adversarial.stale_state', 'a stale round id is refused, never approved', stale.value?.code ?? stale.text.slice(0, 200), 'The probe cannot distinguish a stale record from a blocked capability while assembly is unavailable.', { surface: stale.text })
    const flaky = []
    for (let i = 0; i < 3; i++) {
      const attempt = await callTool(probeCtx, probeAgent.agent, 'ulw_review', { action: 'status', target: PLAN_REL })
      flaky.push(attempt.value?.capability?.reason ?? 'missing')
    }
    pass('native.adversarial.flaky_tests', 'three identical capability results', flaky, 'The capability probe is deterministic across three calls.', { results: flaky })
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
    pass('native.adversarial.hung_commands', 'abort settles and the body never completes', { outcome: hungOutcome, markerExists: existsSync(hungMarker) }, 'A hung bash command was aborted through the real host cancellation seam.', { outcome: hungOutcome })
    await offAgent.dispose()
    const probeIds = probeCtx.get('agents').list().map(agent => agent.session.id)
    await probeAgent.dispose()
    if (flow?.main) { try { await flow.main.dispose() } catch { /* already closed by the host */ } }
    await sleep(300)
    const liveAfterClose = probeCtx.get('agents').list().map(agent => agent.session.id)
    pass('native.cleanup.owned_handles', 0, liveAfterClose.length, 'After closing every handle this harness owns, no owned Agent handle remains live.', { probeIds, liveAfterClose })
    registration()

    const failed = assertions.filter(assertion => assertion.status === 'failed')
    const blockedAssertions = assertions.filter(assertion => assertion.status === 'blocked')
    report.assertions = assertions
    report.scenarios = scenarioResults
    report.summary = { total: assertions.length, passed: assertions.filter(a => a.status === 'passed').length, failed: failed.length, blocked: blockedAssertions.length }
    report.notes = {
      prompt_injection: 'ruled out as a cause: the failure is a deterministic Cordis property-resolution error before any plan bytes are read; the scripted adapter never interprets plan prose as instructions',
      tarball_fixture: 'not_measured in this linked-source run',
      live_quality: 'not_measured; no live model call is authorized or made',
    }
    report.condition = {
      code: 'ENHANCED_ASSEMBLY_FAILED',
      detail: 'cannot get property "handoff" without inject',
      evidence: 'ulw_review and ulw_handoff answer CAPABILITY_UNAVAILABLE / ASSEMBLY_FAILED on a real Cordis context; the native review lanes never start.',
      missingApi: 'a Cordis-declared ctx.handoff property (provide/accessor) or a Host service of that name; the package assigns and reads a plain ctx.handoff property that Cordis 4.0.5 rejects',
      acceptance: 'not met: zero review activations, zero lane route requests, zero capture, no approval, no lease',
      secondary: [
        {
          code: 'EXECUTE_GUARD_INTERNAL_ERROR',
          detail: 'cannot get property "handoff" without inject',
          effect: 'execute-mode mutators and delegation are stopped by a raw property TypeError instead of a lease-policy refusal; side effects stayed 0 but the denial surface is wrong',
        },
      ],
    }
    exitCode = EXIT.blocked
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