/**
 * dsh-ulw-plan Host plugin entry.
 *
 * The bundle registers omo's explore -> plan -> execute workflow on the Host
 * plane using DSH-native surfaces only: one session-mode projection, one write
 * guard, the three `/ulw-*` commands, the two user-invocable planning skills,
 * and the enhanced dual-review entrypoints (`ulw_review` plus the hosted
 * `/ulw-review` round receipt). The review sub-effect also assembles row 13's
 * execution handoff: it injects `ctx.handoff` (built from the durable review
 * store, the live approval seam and the current review policy) for the write
 * guard and registers `ulw_handoff` with check/bootstrap/bind-worktree
 * selectors only. Research delegation and worker spawning use the Host's own
 * subagent tools, so no role presets and no ported task tool are registered,
 * and no runtime dependency is imported.
 *
 * The root injection stays exactly as it was: the original skills, consult,
 * mode and guard register even when every enhanced service is absent. The
 * enhanced review modules assemble through their own sub-effect with optional
 * service detection; a missing subagents/agentPresets/llm/storage set leaves
 * the original contributions working and makes the enhanced entrypoints answer
 * with a specific capability diagnostic instead of silently approving.
 *
 * @module dsh-ulw-plan
 */
import { registerCommands } from './commands.js'
import { registerGuard } from './guard.js'
import { registerProjection } from './projection.js'
import { REVIEW_ENTRY_EFFECT, createReviewEntry } from './review-tools.js'
import { registerSkills } from './skills.js'

/** Plugin name used by the bundle row and diagnostics. */
export const name = 'dsh-ulw-plan'

/** Host services this plugin requires. Optional enhanced services are detected, not injected. */
export const inject = ['tools', 'sessionProjections', 'workingDirectory', 'skills', 'commands']

/**
 * Install the dsh-ulw-plan contributions into the Host context.
 *
 * Effects unload in reverse registration order, so the review entrypoint (and
 * its ordered dispose) tears down before commands, skills, guard and
 * projection. The review tool is registered inside createReviewEntry so an
 * HMR reload never depends on a module-level mutable registry.
 *
 * @param ctx - Cordis context owned by this plugin's fiber.
 * @param config - optional plugin config; `{ review: <raw review config> }` is
 *   the only enhanced field (safe default: absent = disabled).
 * @returns Promise resolved once every contribution is registered.
 */
export async function apply(ctx, config) {
  ctx.effect(() => registerProjection(ctx), 'dsh-ulw-plan:projection')
  ctx.effect(() => registerGuard(ctx), 'dsh-ulw-plan:guard')
  const review = createReviewEntry(ctx, { config })
  ctx.effect(() => registerCommands(ctx, { review: review.router }), 'dsh-ulw-plan:commands')
  ctx.effect(() => registerSkills(ctx), 'dsh-ulw-plan:skills')
  ctx.effect(() => review.start(), REVIEW_ENTRY_EFFECT)

  ctx.logger.info('dsh-ulw-plan: loaded')
}
