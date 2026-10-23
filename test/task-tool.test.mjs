/**
 * `task` behaviour at its public boundary: schema resolution, the exactly-one
 * dispatch rule, recursion refusal, the plan-gate, and the inline result.
 *
 * The subagent service is a small fake so the tests describe the contract the
 * tool relies on (spawn, caller delivery, preset selection, awaited result,
 * disposal) without spawning real models.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTaskTool, resolveSubagentType } from '../lib/task-tool.js'

const workspace = () => mkdtempSync(join(tmpdir(), 'dsh-ulw-plan-task-'))

function agentAt(cwd, depth = 0) {
  const session = { header: { cwd, ...(depth === 0 ? {} : { delegationDepth: depth }) } }
  return { session }
}

function harness({ cwd, mode = 'plan', depth = 0, result } = {}) {
  const agent = agentAt(cwd, depth)
  const captured = { spawn: undefined, disposed: false }
  const settled = result ?? {
    output: [{ type: 'text', text: `hello from ${cwd}` }],
    stopReason: 'completed',
  }
  const ctx = {
    workingDirectory: { get: () => cwd },
    sessionProjections: {
      stateOf: (session, key) => (key === 'ulwMode' ? { mode } : undefined),
    },
    subagents: {
      async startActivation(spec) {
        captured.spawn = spec
        return {
          childId: 'child-session-1',
          result: Promise.resolve(settled),
          async dispose() {
            captured.disposed = true
          },
        }
      },
    },
  }
  return { tool: createTaskTool(ctx), agent, captured }
}

const exec = (agent) => ({ agent, signal: new AbortController().signal })

test('aliases resolve to the mounted preset ids', () => {
  assert.equal(resolveSubagentType('metis'), 'plan-consultant')
  assert.equal(resolveSubagentType('momus'), 'plan-reviewer')
  assert.equal(resolveSubagentType('oracle'), 'plan-reviewer')
  assert.equal(resolveSubagentType('explore'), 'explore')
  assert.equal(resolveSubagentType('nope'), undefined)
})

test('exactly one of subagent_type and category is required', async () => {
  const cwd = workspace()
  const { tool, agent } = harness({ cwd, mode: 'off' })
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y' }, exec(agent)),
    /exactly one of/,
  )
  await assert.rejects(
    tool.execute({ description: 'x', prompt: 'y', subagent_type: 'explore', category: 'quick' }, exec(agent)),
    /exactly one of/,
  )
})

test('a role agent at delegation depth 1 cannot delegate', async () => {
  const cwd = workspace()
  const { tool, agent, captured } = harness({ cwd, mode: 'off', depth: 1 })
  await assert.rejects(
    tool.execute({ description: 'map files', prompt: 'list lib', subagent_type: 'explore' }, exec(agent)),
    /role agents cannot delegate/,
  )
  assert.equal(captured.spawn, undefined)
})

test('an explore child spawns with its preset and returns text inline', async () => {
  const cwd = workspace()
  const { tool, agent, captured } = harness({ cwd, mode: 'off' })
  const value = await tool.execute(
    { description: 'map files', prompt: 'list lib', subagent_type: 'explore' },
    exec(agent),
  )
  assert.equal(value.text, `hello from ${cwd}`)
  assert.equal(value.preset, 'explore')
  assert.equal(value.stopReason, 'completed')
  assert.equal(captured.spawn.provider, 'spawn')
  assert.equal(captured.spawn.delivery, 'caller')
  assert.equal(captured.spawn.request.agentPreset, 'explore')
  assert.equal(captured.spawn.request.parent, agent)
  assert.equal(captured.disposed, true)
})

test('a category child inherits the parent preset', async () => {
  const cwd = workspace()
  const { tool, agent, captured } = harness({ cwd, mode: 'execute' })
  await tool.execute({ description: 'write it', prompt: 'implement', category: 'quick' }, exec(agent))
  assert.equal('agentPreset' in captured.spawn.request, false)
})

test('categories are refused while planning', async () => {
  const cwd = workspace()
  const { tool, agent, captured } = harness({ cwd, mode: 'plan' })
  writeArtifact(cwd, 'drafts', 'x.md')
  await assert.rejects(
    tool.execute({ description: 'write it', prompt: 'implement', category: 'quick' }, exec(agent)),
    /category spawns an implementer/,
  )
  assert.equal(captured.spawn, undefined)
})

test('a consultant is refused without an artifact', async () => {
  const cwd = workspace()
  const { tool, agent, captured } = harness({ cwd, mode: 'plan' })
  await assert.rejects(
    tool.execute({ description: 'gaps', prompt: 'analyse', subagent_type: 'metis' }, exec(agent)),
    /no artifact yet/,
  )
  assert.equal(captured.spawn, undefined)
})

test('a reviewer is refused with a plan path that does not exist', async () => {
  const cwd = workspace()
  writeArtifact(cwd, 'drafts', 'draft.md')
  const { tool, agent } = harness({ cwd, mode: 'plan' })
  await assert.rejects(
    tool.execute(
      { description: 'review', prompt: 'review .dsh/ulw/plans/missing.md', subagent_type: 'momus' },
      exec(agent),
    ),
    /does not exist/,
  )
})

test('a reviewer runs in plan mode against one existing plan', async () => {
  const cwd = workspace()
  writeArtifact(cwd, 'plans', 'feature.md')
  const { tool, agent, captured } = harness({ cwd, mode: 'plan' })
  const value = await tool.execute(
    { description: 'review', prompt: 'review .dsh/ulw/plans/feature.md', subagent_type: 'oracle' },
    exec(agent),
  )
  assert.equal(value.preset, 'plan-reviewer')
  assert.equal(captured.spawn.request.agentPreset, 'plan-reviewer')
})

test('a reviewer is refused in execute mode', async () => {
  const cwd = workspace()
  writeArtifact(cwd, 'plans', 'feature.md')
  const { tool, agent } = harness({ cwd, mode: 'execute' })
  await assert.rejects(
    tool.execute(
      { description: 'review', prompt: 'review .dsh/ulw/plans/feature.md', subagent_type: 'plan-reviewer' },
      exec(agent),
    ),
    /planning review is over/,
  )
})

test('a failed child still returns its diagnostic and is disposed', async () => {
  const cwd = workspace()
  const { tool, agent, captured } = harness({
    cwd,
    mode: 'off',
    result: { output: [], stopReason: 'error', diagnostic: 'child failed loudly' },
  })
  const value = await tool.execute(
    { description: 'map', prompt: 'list files', subagent_type: 'explore' },
    exec(agent),
  )
  assert.equal(value.stopReason, 'error')
  assert.match(value.text, /child failed loudly/)
  assert.equal(captured.disposed, true)
})

test('a failing disposal never replaces a successful result', async () => {
  const cwd = workspace()
  const agent = agentAt(cwd, 0)
  const ctx = {
    workingDirectory: { get: () => cwd },
    sessionProjections: { stateOf: () => ({ mode: 'off' }) },
    subagents: {
      async startActivation() {
        return {
          childId: 'child-session-2',
          result: Promise.resolve({ output: [{ type: 'text', text: 'kept' }], stopReason: 'completed' }),
          async dispose() {
            throw new Error('teardown exploded')
          },
        }
      },
    },
  }
  const value = await createTaskTool(ctx).execute(
    { description: 'map', prompt: 'list files', subagent_type: 'explore' },
    { agent, signal: new AbortController().signal },
  )
  assert.equal(value.text, 'kept')
})

test('the tool declares an output contract and stays concurrency-safe', () => {
  const cwd = workspace()
  const { tool } = harness({ cwd })
  assert.equal(tool.name, 'task')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.isConcurrencySafe(), true)
})

function writeArtifact(cwd, directory, name) {
  mkdirSync(join(cwd, '.dsh', 'ulw', directory), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'ulw', directory, name), '# artifact')
}
