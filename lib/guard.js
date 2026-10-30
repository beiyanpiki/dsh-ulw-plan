/**
 * The planning write guard.
 *
 * During `ulwMode === 'plan'`, the Host refuses `write` and `edit` targets that
 * are not inside `.dsh/ulw/`. This is the code-enforced version of omo's
 * prometheus-md-only hook: the planner may write plans and drafts, never
 * product code.
 *
 * In `execute` mode the plan projection alone is still not an authorization.
 * An optional Host-owned handoff service (`ctx.handoff`) supplies the
 * required-only lease gate: until a verified lease exists, product `write`/
 * `edit` targets, `bash`, `run_code`, implementation spawns and unknown
 * side-effect tools are refused, while read-only, plan/draft authoring and
 * review/handoff/goal/todo/question tools stay available. A verified required
 * lease revalidates the plan instruction hash on every side-effect entry, so a
 * legal status tick keeps the lease and any edited instruction revokes it.
 *
 * Deliberately out of scope, matching omo:
 *   - `bash` is not gated in plan mode (the mandated `scaffold-plan.mjs`
 *     runs through it); execution-mode bash is gated by the handoff lease;
 *   - read-only tools are never gated;
 *   - the gate is per session: a subagent session starts at `off`.
 *
 * @module dsh-ulw-plan/guard
 */
import { isUnderArtifactRoot } from './paths.js'

/** Tools that can modify a file. */
const MUTATORS = new Set(['write', 'edit'])

/** Refusal text; it names both ways out so a user can never be trapped. */
const REFUSAL =
  'ulw-plan mode: planning only. Product files are read-only; write only under .dsh/ulw/ ' +
  '(drafts and plans). Run /ulw-mode execute to execute the plan, or /ulw-mode off to leave the workflow.'

/**
 * Build the guard function for one Host context.
 * @param ctx - context providing `sessionProjections` and `workingDirectory`.
 * @returns a synchronous `tools.guard` callback: a string denies the call.
 */
export function createGuard(ctx) {
  return (exec) => {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const mode = ctx.sessionProjections.stateOf(agent.session, 'ulwMode')?.mode
    if (mode === 'plan') {
      if (!MUTATORS.has(exec.name)) return undefined
      const cwd = agent.session.header.cwd ?? ctx.workingDirectory.get(agent.session)
      const target = exec.arguments?.file_path
      if (typeof target === 'string' && target.trim() !== '' && isUnderArtifactRoot(cwd, target)) return undefined
      return REFUSAL
    }
    if (mode === 'execute') {
      const handoff = ctx.handoff
      if (handoff !== undefined && handoff !== null && typeof handoff.guard === 'function') {
        const reason = handoff.guard(exec)
        if (typeof reason === 'string' && reason.length > 0) return reason
      }
    }
    return undefined
  }
}

/**
 * Register the guard on the Host context.
 * @param ctx - context providing `tools`.
 * @returns the exact disposer that unregisters the guard.
 */
export function registerGuard(ctx) {
  return ctx.tools.guard(createGuard(ctx))
}
