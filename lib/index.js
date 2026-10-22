/**
 * dsh-omo Host plugin entry.
 *
 * The bundle registers omo's explore -> plan -> execute workflow on the Host
 * plane: one session-mode projection, one write guard, the `/ulw-mode` command,
 * the inline `task` tool, the two user-invocable planning skills, and the four
 * read-only role presets. No shipped preset is taken over and no runtime
 * dependency is imported, so the plugin survives DSH upgrades.
 *
 * @module dsh-omo
 */
import { registerProjection } from './projection.js'

/** Plugin name used by the bundle row and diagnostics. */
export const name = 'dsh-omo'

/** Host services this plugin requires. */
export const inject = ['tools', 'sessionProjections']

/**
 * Install the dsh-omo contributions into the Host context.
 * @param ctx - Cordis context owned by this plugin's fiber.
 * @returns Promise resolved once every contribution is registered.
 */
export async function apply(ctx) {
  ctx.effect(() => registerProjection(ctx), 'dsh-omo:projection')
  ctx.logger.info('dsh-omo: loaded')
}
