/**
 * The `ulwMode` session projection: omo's sticky plan/execute mode as a pure
 * fold over two KNOWN session events.
 *
 * Why only known events: the persistent read path rejects unknown,
 * non-ignorable event types, and a plugin cannot import `@deepseek-ai/dsh-session`
 * to append an ignorable record (a second package copy would break the module's
 * static hook). So the mode is derived from:
 *   1. `command/run` written by the commands service for `/ulw-mode <mode>`;
 *   2. `user/message` with `source.kind === 'skill-invocation'`, written when the
 *      user invokes `/ulw-plan` or `/ulw-execute`.
 *
 * @module dsh-omo/projection
 */

/** Every legal ulw mode, in ascending privilege order. */
export const ULW_MODES = Object.freeze(['off', 'plan', 'execute'])

/**
 * Coerce one candidate value to a legal mode.
 * @param value - candidate mode text.
 * @returns the legal mode, or undefined for anything else.
 */
export function parseMode(value) {
  return typeof value === 'string' && ULW_MODES.includes(value) ? value : undefined
}

/**
 * The projection unit registered on `ctx.sessionProjections`.
 * `apply` is a pure synchronous fold and MUST return the same state reference
 * when the event is not ours.
 */
export const ulwModeProjection = {
  key: 'ulwMode',
  stateVersion: 1,
  /**
   * Persisted-state guard. Only `.parse` is used by the projection framework;
   * anything unreadable seeds `off` instead of crashing a resumed session.
   */
  stateSchema: {
    parse(value) {
      const mode = value !== null && typeof value === 'object' ? parseMode(value.mode) : undefined
      return { mode: mode ?? 'off' }
    },
  },
  /** Empty-log state for one Session. */
  init() {
    return { mode: 'off' }
  },
  /**
   * Fold one committed event.
   * @param state - state covering every prior event.
   * @param event - the next committed session event.
   * @returns the next state, or the SAME reference when uninterested.
   */
  apply(state, event) {
    if (event.type === 'command/run' && event.data?.name === 'ulw-mode') {
      const mode = parseMode(typeof event.data.args === 'string' ? event.data.args.trim() : undefined)
      if (mode !== undefined) return { mode }
      return state
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'skill-invocation') {
      const name = event.data.source.name
      if (name === 'ulw-plan') return { mode: 'plan' }
      if (name === 'ulw-execute') return { mode: 'execute' }
    }
    return state
  },
}

/**
 * Register the projection on the Host context.
 * @param ctx - context providing `sessionProjections`.
 * @returns the exact disposer that unregisters the unit.
 */
export function registerProjection(ctx) {
  return ctx.sessionProjections.register(ulwModeProjection)
}
