/**
 * omo's plan-gate as a pure decision.
 *
 * omo gates `plan-consultant` / `plan-reviewer` on three conditions: the
 * `ulw-plan` skill is active, a plan artifact exists, and `ulw-execute` is not
 * active. This port keeps that shape:
 *   1. `mode === 'plan'`;
 *   2. a draft or plan artifact exists under `.dsh/ulw/`;
 *   3. the session is not in `execute` mode (which rejects both roles anyway).
 *
 * A reviewer additionally needs exactly ONE existing `.dsh/ulw/plans/<slug>.md`
 * path in its prompt; that is what makes the review target unambiguous.
 *
 * @module dsh-ulw-plan/gate
 */
import { isAbsolute, resolve } from 'node:path'
import { isWithin } from './paths.js'

/** Roles that may only be spawned while planning. */
export const CONSULTANT_TYPES = Object.freeze(['plan-consultant', 'metis'])
export const REVIEWER_TYPES = Object.freeze(['plan-reviewer', 'momus', 'oracle'])

/** A `.dsh/ulw/plans/<slug>.md` mention in free text. */
const PLAN_PATH = /\.dsh\/ulw\/plans\/[A-Za-z0-9][A-Za-z0-9._-]*\.md/g

/**
 * Extract the distinct plan paths mentioned in a prompt.
 * @param prompt - the delegation prompt.
 * @returns unique matched paths in first-seen order.
 */
export function collectPlanPaths(prompt) {
  if (typeof prompt !== 'string') return []
  return [...new Set(prompt.match(PLAN_PATH) ?? [])]
}

/**
 * Decide whether one `task` call may start its child.
 * @param options - the four gate inputs plus injected filesystem facts.
 * @param options.mode - current `ulwMode`.
 * @param options.type - resolved preset id, or undefined for a category dispatch.
 * @param options.category - implementer category, or undefined for a role dispatch.
 * @param options.prompt - the delegation prompt.
 * @param options.cwd - the session working directory used to resolve plan paths.
 * @param options.artifactExists - whether any ulw draft/plan artifact exists.
 * @param options.planExists - whether one resolved plan file exists.
 * @returns a self-explaining refusal, or undefined when the call is allowed.
 */
export function checkGate({ mode, type, category, prompt, cwd, artifactExists, planExists }) {
  if (category !== undefined && mode === 'plan') {
    return (
      'ulw-plan mode: category spawns an implementer, and the planner must not dispatch implementation. ' +
      'Run /ulw-execute first, or delegate read-only research with subagent_type="explore"/"librarian".'
    )
  }
  const reviewer = REVIEWER_TYPES.includes(type)
  const consultant = CONSULTANT_TYPES.includes(type)
  if (!reviewer && !consultant) return undefined

  if (mode === 'execute') {
    return (
      `ulw-execute mode: ${type} is not available once execution starts - planning review is over. ` +
      'Finish or /ulw-mode off before asking for another review.'
    )
  }
  if (mode !== 'plan') {
    return (
      `ulw-plan mode is required to spawn ${type}. Run /ulw-plan <request> first ` +
      '(or /ulw-mode plan when a plan artifact already exists).'
    )
  }
  if (!artifactExists) {
    return (
      `ulw-plan mode has no artifact yet: write a draft or plan under .dsh/ulw/ before spawning ${type}. ` +
      'Run the skill\'s scaffold-plan.mjs to create the draft first.'
    )
  }
  if (!reviewer) return undefined

  const paths = collectPlanPaths(prompt)
  if (paths.length !== 1) {
    return (
      `${type} requires exactly one .dsh/ulw/plans/<slug>.md path in the prompt; found ${paths.length}. ` +
      'Pass the single plan to review and nothing ambiguous.'
    )
  }
  const absolute = isAbsolute(paths[0]) ? paths[0] : resolve(cwd, paths[0])
  if (!isWithin(resolve(cwd, '.dsh', 'ulw', 'plans'), absolute)) {
    return `${type} may only review a plan inside .dsh/ulw/plans/: ${paths[0]}`
  }
  if (!planExists(absolute)) {
    return `${type} plan path does not exist: ${paths[0]}`
  }
  return undefined
}
