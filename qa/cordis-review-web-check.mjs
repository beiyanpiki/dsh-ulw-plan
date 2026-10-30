#!/usr/bin/env node
/**
 * Read-only compatibility probe for the EXISTING DSH Web GUI (ULW plan row 18).
 *
 * It never starts, restarts or replaces the running server, never opens a real
 * session, and never reads credentials or cookies. It asks the URL for its
 * public HTTP surface, records the exact authentication condition, and then
 * inspects the live Web profile's public install graph to identify which
 * package root/version the running profile resolves.
 *
 * Exact invocation (Verification strategy):
 *   node qa/cordis-review-web-check.mjs \
 *     --url http://127.0.0.1:30800 \
 *     --out .dsh/ulw/evidence/cordis-dual-plan-review/web
 *
 * Exit codes: 0 the loaded package and the public live surfaces were verified;
 * 4 blocked (the exact condition is recorded in assertions.json); 64 usage.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
const SCHEMA = 'ulw-cordis-web-check/v1'
const EXIT = { ok: 0, blocked: 4, usage: 64 }
const argv = process.argv.slice(2)

function parseArgs (args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--url') out.url = args[++i]
    else if (arg === '--out') out.out = args[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return out
}
function usage (message) {
  process.stderr.write((message ? message + '\n' : '') + 'usage: node qa/cordis-review-web-check.mjs --url <existing-gui-url> --out <dir>\n')
  process.exit(EXIT.usage)
}
const options = (() => { try { return parseArgs(argv) } catch (error) { usage(error.message) } })()
if (options.help) usage()
if (!options.url || !options.out) usage('missing --url or --out')
let targetUrl
try { targetUrl = new URL(options.url) } catch { usage('invalid --url') }
if (!['http:', 'https:'].includes(targetUrl.protocol)) usage('--url must be http(s)')

const OUT = resolve(options.out)
const tracePath = join(OUT, 'run-trace.jsonl')
const assertions = []
const startedAt = new Date().toISOString()
let sequence = 0

function trace (step, data = {}) {
  try { appendFileSync(tracePath, JSON.stringify({ at: new Date().toISOString(), seq: ++sequence, step, ...data }) + '\n') } catch { /* assertions keep the evidence */ }
}
function record (id, status, expected, actual, detail, extra = {}) {
  const assertion = { id, status, expected, actual, detail: detail || '', ...extra }
  assertions.push(assertion)
  trace('assertion', assertion)
  return assertion
}
const pass = (id, expected, actual, detail, extra) => record(id, 'passed', expected, actual, detail, extra)
const fail = (id, expected, actual, detail, extra) => record(id, 'failed', expected, actual, detail, extra)
const blocked = (id, expected, actual, detail, extra) => record(id, 'blocked', expected, actual, detail, extra)

function httpProbe (url, timeoutMs = 5000) {
  return new Promise(resolvePromise => {
    const request = http.request(url, {
      method: 'GET',
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'user-agent': 'ulw-cordis-web-check/1 (read-only)' },
      timeout: timeoutMs,
    }, response => {
      const chunks = []
      let bytes = 0
      response.on('data', chunk => {
        if (bytes < 4096) chunks.push(chunk)
        bytes += chunk.length
      })
      response.on('end', () => resolvePromise({ ok: true, status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), bytes }))
    })
    request.on('timeout', () => { request.destroy(new Error('TIMEOUT')) })
    request.on('error', error => resolvePromise({ ok: false, error: error.code || error.message }))
    request.end()
  })
}

function readJson (file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}
function safeRealpath (file) {
  try { return realpathSync(file) } catch { return undefined }
}

function liveProfileFacts () {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = join(home, 'profiles', 'web')
  const manifestFile = join(profileDir, 'package.json')
  const manifest = readJson(manifestFile)
  const dependency = manifest?.dependencies?.['dsh-ulw-plan']
  const linkedEntry = join(profileDir, 'node_modules', 'dsh-ulw-plan')
  const resolvedRoot = safeRealpath(linkedEntry) || (dependency?.startsWith('link:') ? safeRealpath(dependency.slice(5)) : undefined)
  const loadedPackage = resolvedRoot ? readJson(join(resolvedRoot, 'package.json')) : undefined
  const reviewModule = resolvedRoot ? join(resolvedRoot, 'lib', 'review-tools.js') : undefined
  const underTestRoot = safeRealpath(PACKAGE_ROOT)
  const underTestPackage = readJson(join(PACKAGE_ROOT, 'package.json'))
  return {
    home,
    profileDir,
    manifestFile,
    profileExists: existsSync(profileDir),
    dependency,
    linkedEntry,
    linkedEntrySymlink: (() => { try { return readlinkSync(linkedEntry) } catch { return undefined } })(),
    resolvedRoot,
    loadedPackage,
    reviewModule,
    reviewModulePresent: reviewModule ? existsSync(reviewModule) : false,
    underTestRoot,
    underTestPackage,
    sameRoot: resolvedRoot !== undefined && underTestRoot !== undefined && resolvedRoot === underTestRoot,
  }
}

async function main () {
  mkdirSync(OUT, { recursive: true })
  const report = {
    schema: SCHEMA,
    task: 18,
    generatedAt: startedAt,
    argv,
    url: targetUrl.origin + targetUrl.pathname,
    label: 'existing-live-gui',
    live_quality: 'not_measured',
    assertions: [],
    condition: null,
  }
  let exitCode = EXIT.ok
  try {
    const rootProbe = await httpProbe(new URL('/', targetUrl))
    trace('http-root', { status: rootProbe.status, bytes: rootProbe.bytes, error: rootProbe.error, body: rootProbe.ok ? rootProbe.body.slice(0, 200) : undefined })
    if (!rootProbe.ok) {
      fail('web.http.reachable', 'an HTTP response from the existing GUI', rootProbe.error, 'The existing GUI URL did not answer a read-only request.')
      report.condition = { code: 'WEB_UNREACHABLE', detail: 'HTTP probe failed: ' + rootProbe.error }
      exitCode = EXIT.blocked
      throw new Error(report.condition.detail)
    }
    pass('web.http.reachable', 'an HTTP response', { status: rootProbe.status, bytes: rootProbe.bytes }, 'The existing server answered without being started or replaced.')
    if (rootProbe.status === 401) {
      pass('web.http.authentication_gate', 401, rootProbe.status, 'The server requires its launch-token cookie and returned its documented 401 page.', { body: rootProbe.body.slice(0, 120) })
    } else {
      blocked('web.http.authentication_gate', 401, rootProbe.status, 'The root response was not the documented unauthenticated page; live state was not forced.', { body: rootProbe.body.slice(0, 120) })
    }
    const apiProbe = await httpProbe(new URL('/api', targetUrl))
    trace('http-api', { status: apiProbe.status, error: apiProbe.error })
    if (apiProbe.ok && apiProbe.status === 401) {
      pass('web.api.authentication_gate', 401, apiProbe.status, 'The /api transport requires a signed browser or operator cookie; no token, cookie or real session was used.')
    } else {
      blocked('web.api.authentication_gate', 401, { status: apiProbe.status, error: apiProbe.error }, 'The /api transport did not present its documented unauthenticated status.')
    }
    blocked('web.runtime.session', 'a public live diagnostic or test session', 'not attempted', 'The documented launch token is not present in the URL or any public environment; opening a session would require the browser cookie.')
    blocked('web.menu.commands', ['ulw-plan', 'ulw-execute', 'ulw-consult', 'ulw-review', 'ulw-mode'], 'not measured', 'The command menu is served only after cookie authentication.')
    blocked('web.tools.ulw_review', 'registered ulw_review/ulw_handoff tools', 'not measured', 'Tool state is exposed only through the authenticated /api transport.')

    const facts = liveProfileFacts()
    trace('profile-facts', {
      home: facts.home,
      profileDir: facts.profileDir,
      dependency: facts.dependency,
      linkedEntrySymlink: facts.linkedEntrySymlink,
      resolvedRoot: facts.resolvedRoot,
      loadedVersion: facts.loadedPackage?.version,
      reviewModulePresent: facts.reviewModulePresent,
      underTestRoot: facts.underTestRoot,
      sameRoot: facts.sameRoot,
    })
    if (facts.resolvedRoot) {
      pass('web.runtime.package_root', facts.resolvedRoot, facts.resolvedRoot, 'The live Web profile install graph resolves dsh-ulw-plan to this package root.', { dependency: facts.dependency, symlink: facts.linkedEntrySymlink })
    } else {
      blocked('web.runtime.package_root', 'a resolved dsh-ulw-plan package root', null, 'The live Web profile has no resolvable dsh-ulw-plan dependency.')
    }
    if (facts.loadedPackage) {
      pass('web.runtime.package_version', 'a readable installed version', facts.loadedPackage.version, 'The resolved package declares this version.', { name: facts.loadedPackage.name })
    } else {
      blocked('web.runtime.package_version', 'a readable installed version', null, 'The resolved package has no readable manifest.')
    }
    if (facts.reviewModule) {
      record('web.runtime.review_modules', facts.reviewModulePresent ? 'passed' : 'failed', 'lib/review-tools.js present in the loaded package', { present: facts.reviewModulePresent, path: facts.reviewModule }, 'The running Web profile must resolve a package that contains the delivered review modules.')
    }
    record('web.runtime.under_test_loaded', facts.sameRoot ? 'passed' : 'failed', facts.underTestRoot, facts.resolvedRoot || null, 'The package under test is the package the live Web profile resolves.', { sameRoot: facts.sameRoot })
    if (!facts.sameRoot || !facts.reviewModulePresent) {
      report.condition = {
        code: 'WEB_LIVE_PACKAGE_NOT_DELIVERED',
        detail: 'the existing GUI profile resolves dsh-ulw-plan to ' + (facts.resolvedRoot || '<unresolved>') + ' (version ' + (facts.loadedPackage?.version || 'unknown') + ') without lib/review-tools.js; the package under test is ' + facts.underTestRoot,
        auth: rootProbe.status === 401 ? 'launch-token 401: no public token/cookie is available, so live menu/tool/session state cannot be read without touching a real session' : 'unexpected root status ' + rootProbe.status,
        acceptance: 'not met: the new package is not loaded by the existing GUI and its authenticated diagnostic surface is unreachable',
      }
      exitCode = EXIT.blocked
    }
    report.assertions = assertions
    report.facts = {
      liveRoot: facts.resolvedRoot || null,
      liveVersion: facts.loadedPackage?.version || null,
      reviewModulePresent: facts.reviewModulePresent,
      underTestRoot: facts.underTestRoot,
      underTestVersion: facts.underTestPackage?.version || null,
      rootStatus: rootProbe.status,
      apiStatus: apiProbe.status,
    }
    report.summary = { total: assertions.length, passed: assertions.filter(a => a.status === 'passed').length, failed: assertions.filter(a => a.status === 'failed').length, blocked: assertions.filter(a => a.status === 'blocked').length }
    if (!report.condition) {
      report.condition = { code: 'WEB_AUTHENTICATED_STATE_NOT_OBSERVED', detail: 'the live package looks delivered, but no authenticated public diagnostic was available', auth: 'launch-token 401' }
      exitCode = EXIT.blocked
    }
  } catch (error) {
    trace('fatal', { message: error?.stack || String(error) })
    if (!report.condition) report.condition = { code: 'HARNESS_BLOCKED', detail: error?.message || String(error) }
    report.assertions = assertions
    report.summary = { total: assertions.length, passed: assertions.filter(a => a.status === 'passed').length, failed: assertions.filter(a => a.status === 'failed').length, blocked: assertions.filter(a => a.status === 'blocked').length }
    exitCode = EXIT.blocked
  } finally {
    report.durationMs = Date.now() - Date.parse(startedAt)
    try { writeFileSync(join(OUT, 'assertions.json'), JSON.stringify(report, null, 2) + '\n') } catch (error) { process.stderr.write('cannot write assertions.json: ' + error.message + '\n') }
    process.stderr.write('cordis-review-web-check: ' + (exitCode === 0 ? 'PASS' : 'BLOCKED') + ' (' + report.condition?.code + '): ' + report.condition?.detail + '\n')
    process.stderr.write('assertions=' + JSON.stringify(report.summary) + ' evidence=' + join(OUT, 'assertions.json') + '\n')
    process.exit(exitCode)
  }
}

await main()
