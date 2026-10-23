/**
 * dsh-ulw-plan Host plugin entry.
 *
 * The bundle registers omo's explore -> plan -> execute workflow on the Host
 * plane using DSH-native surfaces only: one session-mode projection, one write
 * guard, the three `/ulw-*` commands (mode switch plus the in-conversation
 * consultant and reviewer role injections), and the two user-invocable
 * planning skills. Research delegation and worker spawning use the Host's own
 * subagent tools, so no role presets and no ported task tool are registered,
 * and no runtime dependency is imported - the plugin survives DSH upgrades.
 *
 * @module dsh-ulw-plan
 */
import { registerCommands } from './commands.js'
import { registerGuard } from './guard.js'
import { registerProjection } from './projection.js'
import { registerSkills } from './skills.js'

/** Plugin name used by the bundle row and diagnostics. */
export const name = 'dsh-ulw-plan'

/** Host services this plugin requires. */
export const inject = ['tools', 'sessionProjections', 'workingDirectory', 'skills', 'commands']

/**
 * Install the dsh-ulw-plan contributions into the Host context.
 * @param ctx - Cordis context owned by this plugin's fiber.
 * @returns Promise resolved once every contribution is registered.
 */
export async function apply(ctx) {
  ctx.effect(() => registerProjection(ctx), 'dsh-ulw-plan:projection')
  ctx.effect(() => registerGuard(ctx), 'dsh-ulw-plan:guard')
  ctx.effect(() => registerCommands(ctx), 'dsh-ulw-plan:commands')
  ctx.effect(() => registerSkills(ctx), 'dsh-ulw-plan:skills')

  ctx.logger.info('dsh-ulw-plan: loaded')
}
