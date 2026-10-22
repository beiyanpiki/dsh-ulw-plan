/**
 * The four read-only omo role presets.
 *
 * Each definition is an ordinary `PresetDefinition`: a persona carrying the
 * verbatim omo prompt, repository instructions, and a tool surface with no
 * write/edit tools at all. Read-only is a fact of the composition, not a request
 * in the prompt.
 *
 * @module dsh-omo/presets
 */
import { loadPrompt } from './load.js'

/** Preset ids in the order omo introduces them. */
export const ROLE_IDS = Object.freeze(['explore', 'librarian', 'plan-consultant', 'plan-reviewer'])

const ROLE_SPECS = Object.freeze([
  {
    id: 'explore',
    order: 100,
    description: 'Read-only codebase exploration: find files and code, return actionable results.',
    web: false,
  },
  {
    id: 'librarian',
    order: 110,
    description: 'Read-only open-source research: official docs, remote source, and verifiable permalinks.',
    web: true,
  },
  {
    id: 'plan-consultant',
    order: 120,
    description: 'Pre-planning consultant: hidden intent, ambiguities, and AI failure points.',
    web: false,
  },
  {
    id: 'plan-reviewer',
    order: 130,
    description: 'Strict work-plan reviewer: verifiable references and executability, blockers only.',
    web: false,
  },
])

/**
 * Build the Cordis plugin rows every read-only role mounts.
 * `tool-bash` is disabled on Windows, where this deployment has no bash service.
 * @param web - whether the role may research external sources.
 * @returns child plugin rows for the preset.
 */
function rolePlugins(web) {
  return [
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    {
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: { read: true, readImage: false, write: false, edit: false },
    },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    },
    ...(web ? [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true } }] : []),
  ]
}

/**
 * Build the four `PresetDefinition`s, reading the verbatim prompts from disk.
 * @returns fresh definitions ready for `ctx.agentPresets.register`.
 */
export function buildRolePresets() {
  return ROLE_SPECS.map((spec) => ({
    id: spec.id,
    name: `omo ${spec.id}`,
    description: spec.description,
    order: spec.order,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: loadPrompt(spec.id) } },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      ...rolePlugins(spec.web),
    ],
  }))
}

/**
 * Register every role preset and fail loud when one cannot mount.
 * A failed mount is recorded on the preset roster (`broken`), so the roster is
 * re-read after registration instead of trusting the resolved registration.
 * @param ctx - context providing `agentPresets`.
 * @returns a single disposer that unregisters the presets in reverse order.
 */
export async function registerRolePresets(ctx) {
  const disposers = []
  try {
    for (const definition of buildRolePresets()) {
      disposers.push(await ctx.agentPresets.register(definition))
    }
    const roster = await ctx.agentPresets.list()
    const broken = roster.filter((preset) => ROLE_IDS.includes(preset.id) && preset.broken !== undefined)
    if (broken.length > 0) {
      throw new Error(
        'dsh-omo: role presets failed to mount: ' + broken.map((preset) => `${preset.id}: ${preset.broken}`).join('; '),
      )
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        // The original registration failure is the actionable error.
      }
    }
    throw error
  }
  return () => Promise.all(disposers.reverse().map((dispose) => dispose()))
}
