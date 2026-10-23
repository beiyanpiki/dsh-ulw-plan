/**
 * The `/ulw-mode` escape hatch.
 *
 * The command only validates and reports; it never appends an event itself.
 * The commands service already appends `command/run` (with `args`) before the
 * handler runs, and the `ulwMode` projection folds that known event into the
 * session state. `recordInput` must therefore stay at its default `true` —
 * setting it false would strip `args` and the projection could no longer read
 * the requested mode.
 *
 * @module dsh-ulw-plan/commands
 */
import { ULW_MODES } from './projection.js'

/** Command name without the leading slash. */
export const ULW_MODE_COMMAND = 'ulw-mode'

/** Usage text shown on an invalid invocation. */
export const ULW_MODE_USAGE = 'Usage: /ulw-mode off|plan|execute'

/**
 * Register `/ulw-mode`.
 * @param ctx - context providing `commands`.
 * @returns the exact disposer that unregisters the command.
 */
export function registerCommand(ctx) {
  return ctx.commands.register({
    name: ULW_MODE_COMMAND,
    description: 'Set the ulw workflow mode for this session (off | plan | execute)',
    input: { hint: 'off | plan | execute' },
    handler({ rawInput }) {
      const mode = rawInput.trim()
      if (!ULW_MODES.includes(mode)) return { kind: 'error', text: ULW_MODE_USAGE }
      return { kind: 'success', text: `ulw mode: ${mode}` }
    },
  })
}
