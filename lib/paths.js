/**
 * The ulw artifact root and its containment rules.
 *
 * omo keeps every durable artifact under `.omo/`; this port keeps the same
 * structure under `.dsh/ulw/`, so the directory never collides with the project
 * root or with another tool's dot-directory.
 *
 * Containment is lexical (`resolve` + `relative`) and additionally rejects a
 * symlink anywhere on the path, because a symlinked `.dsh` would silently move
 * "writes inside the artifact root" somewhere else.
 *
 * @module dsh-ulw-plan/paths
 */
import { lstatSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Root segments of the ulw artifact directory, relative to a session cwd. */
export const ARTIFACT_SEGMENTS = Object.freeze(['.dsh', 'ulw'])

/**
 * Absolute artifact root for one working directory.
 * @param cwd - the session working directory.
 * @returns the absolute `.dsh/ulw` path.
 */
export function artifactRoot(cwd) {
  return resolve(cwd, ...ARTIFACT_SEGMENTS)
}

/**
 * Build one absolute path inside the artifact root.
 * @param cwd - the session working directory.
 * @param segments - path segments below `.dsh/ulw`.
 * @returns the absolute path.
 */
export function artifactPath(cwd, ...segments) {
  return resolve(artifactRoot(cwd), ...segments)
}

/**
 * Whether one path is lexically inside a parent directory.
 * @param parent - absolute parent directory.
 * @param child - candidate path.
 * @returns true when child is parent or a descendant.
 */
export function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Whether a symlink appears on the path from `from` to `to` (inclusive).
 * Missing components stop the scan: they cannot be symlinks yet.
 * @param from - absolute directory the walk starts at.
 * @param to - absolute target path.
 * @returns true when an existing component is a symlink or cannot be inspected.
 */
export function hasSymlinkComponent(from, to) {
  const rel = relative(resolve(from), resolve(to))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return true
  let cursor = resolve(from)
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
      return true
    }
  }
  return false
}

/**
 * Whether a write target may be touched while the session is planning.
 * @param cwd - the session working directory.
 * @param target - the `file_path` argument (relative targets resolve against cwd).
 * @returns true when the target stays inside the artifact root with no symlink escape.
 */
export function isUnderArtifactRoot(cwd, target) {
  if (typeof target !== 'string' || target.trim() === '') return false
  const root = artifactRoot(cwd)
  const absolute = resolve(cwd, target)
  if (!isWithin(root, absolute)) return false
  return !hasSymlinkComponent(cwd, absolute)
}
