/**
 * Package asset loading: prompts, skill markdown, and the single runtime
 * artifact-root transform.
 *
 * The plugin has no build step and no runtime dependencies, so assets are read
 * from the package directory next to `lib/`. Reads are synchronous and happen
 * once at registration; no module-level cache keeps stale content across HMR.
 *
 * @module dsh-omo/load
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute root of the dsh-omo package (the parent of `lib/`). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Token the librarian prompt carries where DSH substitutes the current year. */
export const CURRENT_YEAR_TOKEN = '%%CURRENT_YEAR%%'

/**
 * Read one UTF-8 package asset.
 * @param relativePath - path relative to the package root.
 * @returns the file text.
 */
export function readAsset(relativePath) {
  return readFileSync(join(PACKAGE_ROOT, relativePath), 'utf8')
}

/**
 * Load one vendored role prompt.
 * @param role - `explore`, `librarian`, `plan-consultant`, or `plan-reviewer`.
 * @returns the prompt text with the year token substituted.
 */
export function loadPrompt(role) {
  return readAsset(join('prompts', `${role}.md`)).replaceAll(CURRENT_YEAR_TOKEN, String(new Date().getFullYear()))
}

/**
 * The one mechanical text transform applied to skills at runtime: the same
 * artifact-root rename the files on disk already carry. Keeping it here means a
 * newly added skill line cannot silently reintroduce the old root.
 * @param text - skill markdown.
 * @returns the renamed text.
 */
export function renameArtifacts(text) {
  return text.replaceAll('.omo', '.dsh/ulw')
}

/**
 * Parse the simple YAML frontmatter used by SKILL.md: flat scalar keys only.
 * Nested blocks (for example `metadata:`) are kept out of the result.
 * @param text - complete markdown file.
 * @returns parsed scalar fields and the body without the frontmatter block.
 */
export function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { data: {}, content: normalized }
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized)
  if (match === null) return { data: {}, content: normalized }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (entry === null) continue
    let value = entry[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    data[entry[1]] = value
  }
  return { data, content: normalized.slice(match[0].length) }
}

/**
 * Load one skill directory as a runtime registration payload.
 * @param directory - skill folder name under `skills/`.
 * @returns the skill fields plus its absolute resource base.
 */
export function loadSkill(directory) {
  const skillPath = join(PACKAGE_ROOT, 'skills', directory, 'SKILL.md')
  const { data, content } = parseFrontmatter(readFileSync(skillPath, 'utf8'))
  if (typeof data.name !== 'string' || data.name.trim() === '') {
    throw new Error(`dsh-omo: ${skillPath} has no frontmatter name`)
  }
  if (typeof data.description !== 'string' || data.description.trim() === '') {
    throw new Error(`dsh-omo: ${skillPath} has no frontmatter description`)
  }
  return {
    name: data.name,
    description: data.description,
    content: renameArtifacts(content),
    path: skillPath,
    resourceBase: { kind: 'directory', path: join(PACKAGE_ROOT, 'skills', directory) },
  }
}
