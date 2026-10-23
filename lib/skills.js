/**
 * Register the two ported planning skills.
 *
 * A skill is registered from the markdown on disk:
 *   - `name` and `description` come from the file's frontmatter;
 *   - the body has its frontmatter stripped and carries the registered
 *     artifact-root transform, so a future line cannot reintroduce the old root;
 *   - `resourceBase` points at the skill directory, which is what makes
 *     `node "<skill-root>/scripts/scaffold-plan.mjs"` resolvable for the model.
 *
 * Both skills are model- and user-invocable: `/ulw-plan` and `/ulw-execute` are
 * the gestures the tool-skill layer scans for, and the same names appear in the
 * `/` menu.
 *
 * @module dsh-ulw-plan/skills
 */
import { loadSkill } from './load.js'

/** Directories under `skills/` that this bundle publishes. */
export const SKILL_DIRECTORIES = Object.freeze(['ulw-plan', 'ulw-execute'])

/**
 * Register both skills on the Host context.
 * @param ctx - context providing `skills`.
 * @returns the exact disposer that unregisters them.
 */
export function registerSkills(ctx) {
  const disposers = SKILL_DIRECTORIES.map((directory) => {
    const skill = loadSkill(directory)
    return ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      path: skill.path,
      source: 'runtime',
      resourceBase: skill.resourceBase,
      invocation: { modelInvocable: true, userInvocable: true },
    })
  })
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
