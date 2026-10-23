/**
 * The model-facing `task` tool: omo's delegation surface, inline on DSH.
 *
 * omo calls `task(subagent_type=…)` for read-only roles and `task(category=…)`
 * for an implementer. This tool keeps that signature and the same aliases,
 * while making the result synchronous for the caller: the child is started with
 * `delivery: 'caller'`, its settlement is awaited, and the child is disposed in
 * a `finally` block on every path.
 *
 * @module dsh-ulw-plan/task-tool
 */
import { existsSync } from 'node:fs'
import { checkGate, REVIEWER_TYPES, CONSULTANT_TYPES } from './gate.js'
import { hasUlwArtifact } from './paths.js'

/** Every accepted `subagent_type`, aliases included. */
export const TASK_SUBAGENT_TYPES = Object.freeze([
  'explore',
  'librarian',
  'plan-consultant',
  'plan-reviewer',
  'metis',
  'momus',
  'oracle',
])

/** omo aliases → the preset id that actually mounts. */
export const TASK_ALIASES = Object.freeze({
  explore: 'explore',
  librarian: 'librarian',
  'plan-consultant': 'plan-consultant',
  'plan-reviewer': 'plan-reviewer',
  metis: 'plan-consultant',
  momus: 'plan-reviewer',
  oracle: 'plan-reviewer',
})

/** Implementer classes omo routes by name; DSH keeps the names, not a model chain. */
export const TASK_CATEGORIES = Object.freeze([
  'quick',
  'unspecified-low',
  'unspecified-high',
  'visual-engineering',
  'writing',
  'git',
  'deep-low',
  'deep-high',
  'ultrabrain',
  'architect',
])

/**
 * Resolve an omo subagent type to its preset id.
 * @param name - the requested `subagent_type`.
 * @returns the preset id, or undefined for an unknown name.
 */
export function resolveSubagentType(name) {
  return Object.hasOwn(TASK_ALIASES, name) ? TASK_ALIASES[name] : undefined
}

const TASK_DESCRIPTION =
  'Delegate one focused unit of work to an omo role agent or an implementer and WAIT for its result in this same turn. ' +
  'Use `subagent_type` for the read-only roles explore (internal code), librarian (external docs), plan-consultant/metis ' +
  '(pre-planning gaps), and plan-reviewer/momus/oracle (strict plan review); use `category` to spawn an implementer that ' +
  'inherits this session\'s preset. Exactly one of the two is required. Role children have no write or edit tools. ' +
  'plan-consultant/metis require the session to be in /ulw-plan mode with a draft or plan present; plan-reviewer/momus/oracle ' +
  'additionally require exactly one existing .dsh/ulw/plans/<slug>.md path in the prompt, and are refused in /ulw-execute mode. ' +
  '`run_in_background` is accepted for omo compatibility but does not change the inline behavior; role agents cannot delegate ' +
  '(task is refused at delegation depth 1 or deeper).'

const TASK_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subagent_type: {
      type: 'string',
      enum: [...TASK_SUBAGENT_TYPES],
      description: 'Read-only omo role. Mutually exclusive with `category`.',
    },
    category: {
      type: 'string',
      description:
        'Implementer class (quick, unspecified-low, unspecified-high, visual-engineering, writing, git, deep-low, deep-high, ' +
        'ultrabrain, architect). Mutually exclusive with `subagent_type`; refused while planning.',
    },
    description: {
      type: 'string',
      description: 'A short (3-5 word) description of the delegated task, for display.',
    },
    prompt: {
      type: 'string',
      description: 'The complete, self-contained task. The child does not share this conversation, so include everything it needs.',
    },
    load_skills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Accepted for omo compatibility. Load these skills at launch: not implemented; name them in `prompt` instead.',
    },
    name: {
      type: 'string',
      description: 'Accepted for omo compatibility: an optional display name for the delegated task.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Accepted for omo compatibility. This port always waits inline; the value does not change behavior.',
    },
  },
  required: ['description', 'prompt'],
}

const TASK_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      agent: { type: 'string' },
      preset: { type: 'string' },
      stopReason: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['agent', 'preset', 'stopReason', 'text'],
  },
  render(_args, value) {
    return [{ type: 'text', text: value.text }]
  },
}

/**
 * Read the effective working directory for one agent.
 * @param ctx - context providing `workingDirectory`.
 * @param agent - the delegating agent.
 * @returns its absolute directory.
 */
function cwdOf(ctx, agent) {
  return agent.session.header.cwd ?? ctx.workingDirectory.get(agent.session)
}

/**
 * Join the child's text blocks into the caller-visible answer.
 * @param result - the settled subagent result.
 * @returns non-empty result text.
 */
function resultText(result) {
  const output = result.output
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  const parts = [output, result.diagnostic].filter((part) => typeof part === 'string' && part.trim() !== '')
  return parts.length > 0 ? parts.join('\n\n') : '(the delegated agent produced no text)'
}

/**
 * Build the registered `task` tool bound to one Host context.
 * @param ctx - context providing `subagents`, `sessionProjections`, and `workingDirectory`.
 * @returns the tool definition for `ctx.tools.register`.
 */
export function createTaskTool(ctx) {
  return {
    name: 'task',
    description: TASK_DESCRIPTION,
    parameters: TASK_PARAMETERS,
    output: TASK_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('task requires an agent-backed session')
      const depth = agent.session.header.delegationDepth ?? 0
      if (depth >= 1) {
        throw new Error('role agents cannot delegate: task is only available at delegation depth 0')
      }

      const subagentType = args.subagent_type
      const category = args.category
      if ((subagentType === undefined) === (category === undefined)) {
        throw new Error('task requires exactly one of `subagent_type` or `category`')
      }
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new Error('task requires a non-empty `prompt`')
      }
      if (typeof args.description !== 'string' || args.description.trim() === '') {
        throw new Error('task requires a non-empty `description`')
      }

      const type = subagentType === undefined ? undefined : resolveSubagentType(subagentType)
      if (subagentType !== undefined && type === undefined) {
        throw new Error(`task: unknown subagent_type "${subagentType}"`)
      }
      if (category !== undefined && (typeof category !== 'string' || category.trim() === '')) {
        throw new Error('task requires a non-empty `category`')
      }

      const cwd = cwdOf(ctx, agent)
      const mode = ctx.sessionProjections.stateOf(agent.session, 'ulwMode')?.mode ?? 'off'
      const refusal = checkGate({
        mode,
        type,
        category,
        prompt: args.prompt,
        cwd,
        artifactExists: hasUlwArtifact(cwd),
        planExists: (path) => existsSync(path),
      })
      if (refusal !== undefined) throw new Error(refusal)

      const request = {
        parent: agent,
        prompt: [{ type: 'text', text: args.prompt }],
        maxDepth: 1,
        ...(type === undefined ? {} : { agentPreset: type }),
      }
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: args.description.trim(),
        request,
        signal: exec.signal,
        delivery: 'caller',
      })

      let result
      try {
        result = await activation.result
      } finally {
        try {
          await activation.dispose()
        } catch (error) {
          // The call's own result/failure is the actionable outcome; a teardown
          // warning must not replace it, but it must not vanish either.
          ctx.logger?.warn(
            `dsh-ulw-plan: task child ${activation.childId} disposal failed: ` +
              (error instanceof Error ? error.message : String(error)),
          )
        }
      }

      return {
        agent: activation.childId,
        preset: type ?? '(parent preset)',
        stopReason: result.stopReason,
        text: resultText(result),
      }
    },
  }
}

/** Re-exported for the tool's tests and for readers of the gate contract. */
export { CONSULTANT_TYPES, REVIEWER_TYPES }
