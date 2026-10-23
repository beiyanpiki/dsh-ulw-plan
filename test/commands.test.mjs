/**
 * Command tests: the `/ulw-mode` validation surface, the `/ulw-review`
 * target resolver, and the followup injection both role commands perform.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ULW_CONSULT_COMMAND,
  ULW_MODE_USAGE,
  ULW_REVIEW_COMMAND,
  loadContract,
  registerCommands,
  resolveReviewTarget,
} from '../lib/commands.js'

const workspace = () => mkdtempSync(join(tmpdir(), 'dsh-ulw-plan-commands-'))

/** A minimal agent double that records every queued followup turn. */
function fakeAgent(cwd) {
  const followups = []
  return {
    followups,
    session: { header: { cwd } },
    followup(message) {
      followups.push(message)
    },
  }
}

/** A context double exposing only what the command handlers touch. */
function fakeCtx(mode = 'off') {
  const registrations = []
  return {
    registrations,
    commands: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    sessionProjections: {
      stateOf: (_session, key) => (key === 'ulwMode' ? { mode } : undefined),
    },
    workingDirectory: { get: () => '/fallback-ws' },
  }
}

const byName = (ctx, name) => ctx.registrations.find((definition) => definition.name === name)

const invoke = (definition, rawInput, agent) => definition.handler({ rawInput, agent })

test('registerCommands mounts all three commands and returns one disposer', () => {
  const ctx = fakeCtx()
  const dispose = registerCommands(ctx)
  assert.deepEqual(
    ctx.registrations.map((definition) => definition.name).sort(),
    ['ulw-consult', 'ulw-mode', 'ulw-review'],
  )
  assert.equal(typeof dispose, 'function')
})

test('ulw-mode validates its argument and never touches the agent', () => {
  const ctx = fakeCtx()
  registerCommands(ctx)
  const command = byName(ctx, 'ulw-mode')
  const agent = fakeAgent(workspace())
  assert.deepEqual(invoke(command, ' plan ', agent), { kind: 'success', text: 'ulw mode: plan' })
  assert.deepEqual(invoke(command, 'bogus', agent), { kind: 'error', text: ULW_MODE_USAGE })
  assert.equal(agent.followups.length, 0)
})

test('the role contracts load from the skill references', () => {
  const reviewer = loadContract('plan-reviewer')
  const consultant = loadContract('plan-consultant')
  assert.match(reviewer, /\.dsh\/ulw\/plans/)
  assert.equal(reviewer.includes('.omo'), false)
  assert.equal(consultant.includes('.omo'), false)
  assert.ok(reviewer.length > 500 && consultant.length > 500)
})

test('resolveReviewTarget accepts one existing markdown plan', () => {
  const cwd = workspace()
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), '# feature plan')
  const expected = createHash('sha256').update('# feature plan').digest('hex')

  const relative = resolveReviewTarget('.dsh/ulw/plans/feature.md', cwd)
  assert.equal(relative.ok, true)
  assert.equal(relative.absolute, join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'))
  assert.equal(relative.digest, expected)

  const absolute = resolveReviewTarget(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), cwd)
  assert.equal(absolute.ok, true)
  assert.equal(absolute.digest, expected)
})

test('resolveReviewTarget rejects unusable targets', () => {
  const cwd = workspace()
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), '# feature plan')

  assert.match(resolveReviewTarget('', cwd).error, /Usage: \/ulw-review/)
  assert.match(resolveReviewTarget('   ', cwd).error, /Usage: \/ulw-review/)
  assert.match(resolveReviewTarget('readme.txt', cwd).error, /Usage: \/ulw-review/)
  assert.match(resolveReviewTarget('.dsh/ulw/plans/flow.yml', cwd).error, /YAML plans are not reviewable/)
  assert.match(resolveReviewTarget('docs/feature.md', cwd).error, /must live under \.dsh\/ulw\/plans\//)
  assert.match(resolveReviewTarget('.dsh/ulw/drafts/feature.md', cwd).error, /must live under \.dsh\/ulw\/plans\//)
  assert.match(resolveReviewTarget('.dsh/ulw/plans/missing.md', cwd).error, /no such plan file/)
})

test('ulw-review injects the reviewer contract with the literal target and digest', () => {
  const cwd = workspace()
  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), '# feature plan')
  const digest = createHash('sha256').update('# feature plan').digest('hex')

  const ctx = fakeCtx('plan')
  registerCommands(ctx)
  const agent = fakeAgent(cwd)
  const result = invoke(byName(ctx, ULW_REVIEW_COMMAND), '  .dsh/ulw/plans/feature.md ', agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /reviewer contract injected/)
  assert.equal(agent.followups.length, 1)
  const message = agent.followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'user')
  assert.equal(typeof message.id, 'string')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  const text = message.content[0].text
  assert.match(text, /\/ulw-review/)
  assert.ok(text.includes(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md')))
  assert.ok(text.includes(digest))
  assert.match(text, /plan-reviewer contract|reviewer contract/i)
  assert.equal(text.includes('.omo'), false)
})

test('ulw-review refuses while executing and reports invalid targets without injecting', () => {
  const cwd = workspace()
  const ctx = fakeCtx('execute')
  registerCommands(ctx)
  const agent = fakeAgent(cwd)

  const refused = invoke(byName(ctx, ULW_REVIEW_COMMAND), '.dsh/ulw/plans/feature.md', agent)
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /ulw-execute mode/)

  mkdirSync(join(cwd, '.dsh', 'ulw', 'plans'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', 'plans', 'feature.md'), '# feature plan')
  const offline = fakeCtx('off')
  registerCommands(offline)
  const invalid = invoke(byName(offline, ULW_REVIEW_COMMAND), 'nope.md', fakeAgent(cwd))
  assert.equal(invalid.kind, 'error')
  assert.match(invalid.text, /Usage: \/ulw-review|no such plan file|must live under/)
  assert.equal(agent.followups.length, 0)
})

test('ulw-consult injects the consultant contract with the request', () => {
  const ctx = fakeCtx('plan')
  registerCommands(ctx)
  const agent = fakeAgent(workspace())

  const empty = invoke(byName(ctx, ULW_CONSULT_COMMAND), '   ', agent)
  assert.equal(empty.kind, 'error')
  assert.match(empty.text, /Usage: \/ulw-consult/)

  const result = invoke(byName(ctx, ULW_CONSULT_COMMAND), 'should we split the auth module?', agent)
  assert.equal(result.kind, 'success')
  assert.equal(agent.followups.length, 1)
  const message = agent.followups[0]
  assert.equal(message.role, 'user')
  const text = message.content[0].text
  assert.match(text, /\/ulw-consult/)
  assert.ok(text.includes('should we split the auth module?'))
  assert.match(text, /Intent Classification|consultant contract/i)
})

test('ulw-consult refuses while executing', () => {
  const ctx = fakeCtx('execute')
  registerCommands(ctx)
  const agent = fakeAgent(workspace())
  const result = invoke(byName(ctx, ULW_CONSULT_COMMAND), 'anything', agent)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /ulw-execute mode/)
  assert.equal(agent.followups.length, 0)
})
