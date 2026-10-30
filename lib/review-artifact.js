/** Immutable review input. This is a portable-snapshot, NOT an openat ancestor-fd
 * chain: adversarial ancestor swaps restored between checks cannot be excluded.
 * Nothing here writes the source, persists plan bytes, or emits global logs. */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { parseRows } from '../skills/ulw-execute/scripts/plan-state.mjs'

export const MAX_PAGE_BYTES = 16 * 1024
const snapshots = new WeakMap()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export class ReviewArtifactError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReviewArtifactError'
    this.code = code
  }
}
const fail = (code, message) => { throw new ReviewArtifactError(code, message) }

function asBytes(content) {
  if (Buffer.isBuffer(content)) return Buffer.from(content)
  if (typeof content === 'string') return Buffer.from(content, 'utf8')
  return fail('INVALID_ARTIFACT', 'Expected a UTF-8 string or Buffer')
}
function assertUtf8(bytes) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { fail('INVALID_UTF8', 'Plan bytes must be valid UTF-8') }
}

/** Normalize ONLY status bytes of unambiguous, section-local top-level tasks.
 * The existing tick grammar supplies row recognition; contextual exclusions are
 * intentionally stricter than that legacy parser. Every write is verified against
 * the raw line bytes first: parser calls may ignore a prefix (the section-aware
 * parser strips a line-leading BOM), so a computed offset is never trusted. */
export function computeInstructionSha256(content) {
  const bytes = asBytes(content)
  assertUtf8(bytes)
  let section = null
  let fence = null
  let comment = false
  let html = null
  const rows = []
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start)
    const end = newline < 0 ? bytes.length : newline
    const line = bytes.subarray(start, end).toString('utf8').replace(/\r$/, '')
    const rawFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
    } else if (!comment && !html && rawFence && (rawFence[1][0] !== '`' || !rawFence[2].includes('`'))) {
      // Fence info is code metadata, so comment markers in it are inert.
      fence = { char: rawFence[1][0], length: rawFence[1].length }
    } else if (!/^ {0,3}>/.test(line)) {
      // Replace comments with spaces, retaining byte-column-zero eligibility.
      let visible = ''
      for (let i = 0; i < line.length;) {
        if (comment) {
          const close = line.indexOf('-->', i)
          if (close < 0) { visible += ' '.repeat(line.length - i); break }
          visible += ' '.repeat(close + 3 - i)
          i = close + 3
          comment = false
        } else {
          const open = line.indexOf('<!--', i)
          if (open < 0) { visible += line.slice(i); break }
          visible += line.slice(i, open) + '    '
          i = open + 4
          comment = true
        }
      }
      const container = /^ {0,3}<([a-z][a-z0-9-]*)(?=[\s>])/i.exec(visible)
      const voidTag = container && /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(container[1])
      const nested = html || (container && !voidTag && !/\/\s*>\s*$/.test(visible) ? { tag: container[1], depth: 0 } : null)
      if (nested) {
        const tags = new RegExp('</?' + nested.tag + '(?=[\\s>])[^>]*>', 'gi')
        for (const tag of visible.matchAll(tags)) {
          if (!/\/\s*>$/.test(tag[0])) nested.depth += tag[0][1] === '/' ? -1 : 1
        }
        html = nested.depth > 0 ? nested : null
        start = end + 1
        continue
      }
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(visible)
      if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
        fence = { char: opening[1][0], length: opening[1].length }
      } else if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(visible)) {
        const heading = visible.trimEnd()
        section = heading === '## Todos' ? 'todo' : heading === '## Final verification wave' ? 'final' : null
      } else if (section) {
        const row = parseRows(visible)[0]
        if (row && (section === 'todo' ? /^[1-9]\d*$/.test(row.id) : /^F[1-9]\d*$/.test(row.id))) {
          // Never write at a computed offset without checking the raw bytes. A
          // parser may strip a prefix (a BOM on a per-line call), so require the
          // raw line to start with exactly "- [<status>] " and verify the status
          // byte and its surrounding brackets. Anything else stays instruction.
          const status = bytes[start + 3]
          const canonical = bytes[start] === 0x2d && bytes[start + 1] === 0x20 &&
            bytes[start + 2] === 0x5b && bytes[start + 4] === 0x5d &&
            (status === 0x20 || status === 0x78 || status === 0x7e) &&
            status === row.status.charCodeAt(0)
          rows.push({ id: row.id, offset: start + 3, canonical })
        }
      }
    }
    start = end + 1
  }
  const counts = new Map()
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  for (const row of rows) if (row.canonical && counts.get(row.id) === 1) bytes[row.offset] = 32
  return digest(bytes)
}

function lexicalSource(options) {
  const { workspace, target } = options ?? {}
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || resolve(workspace) !== workspace || workspace.includes('\0')) {
    fail('INVALID_SOURCE', 'Workspace must be a canonical absolute directory')
  }
  if (typeof target !== 'string' || target.includes('\0')) fail('INVALID_SOURCE', 'Expected one canonical Markdown plan target')
  const rel = isAbsolute(target) ? relative(workspace, target) : target
  const match = /^\.dsh\/ulw\/plans\/([a-z0-9][a-z0-9-]{0,79})\.md$/.exec(rel.split(sep).join('/'))
  const path = join(workspace, rel)
  if (!match || target !== (isAbsolute(target) ? path : rel) || rel !== join('.dsh', 'ulw', 'plans', match[1] + '.md')) {
    fail('INVALID_SOURCE', 'Target must be .dsh/ulw/plans/<canonical-slug>.md')
  }
  return Object.freeze({ workspace, relativePath: rel, planPath: path, slug: match[1] })
}
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

async function inspectPath(source) {
  const root = parse(source.planPath).root
  const parts = relative(root, source.planPath).split(sep)
  let path = root
  const chain = []
  // Include the workspace and all its ancestors, not just .dsh descendants.
  for (const part of ['', ...parts]) {
    path = part ? join(path, part) : path
    const stat = await fs.lstat(path, { bigint: true })
    const final = path === source.planPath
    if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) {
      fail('UNSAFE_SOURCE', 'Source must have directory ancestors and a regular non-symlink final file')
    }
    chain.push(stat)
  }
  if (await fs.realpath(source.workspace) !== source.workspace) fail('UNSAFE_SOURCE', 'Workspace is not canonical')
  return chain
}

/** Resolve an existing canonical plan, rejecting every symlink component. */
export async function resolveReviewSource(options) {
  const source = lexicalSource(options)
  try { await inspectPath(source) }
  catch (error) {
    if (error instanceof ReviewArtifactError) throw error
    fail('UNSAFE_SOURCE', 'Source path cannot be safely inspected')
  }
  return source
}

/** Capture all bytes through ONE final fd, bracketed by fd/path identity checks.
 * bytes is copy-on-access: callers cannot mutate the retained original Buffer. */
export async function createReviewArtifact(options) {
  const source = lexicalSource(options)
  let handle
  try {
    const before = await inspectPath(source)
    // NONBLOCK also prevents a swapped FIFO from hanging open; NOFOLLOW rejects
    // final-link swaps where supported. Neither makes ancestor traversal atomic.
    handle = await fs.open(source.planPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const first = await handle.stat({ bigint: true })
    if (!first.isFile() || !sameFile(before.at(-1), first)) fail('STALE_ARTIFACT', 'Source changed before snapshot read')
    const bytes = await handle.readFile()
    const sha256 = digest(bytes)
    const last = await handle.stat({ bigint: true })
    if (!sameFile(first, last) || BigInt(bytes.length) !== last.size) fail('STALE_ARTIFACT', 'Source changed during snapshot read')
    let after
    try { after = await inspectPath(source) }
    catch { fail('STALE_ARTIFACT', 'Source path changed during snapshot read') }
    if (before.length !== after.length || before.some((stat, i) => i === before.length - 1 ? !sameFile(stat, after[i]) : !sameNode(stat, after[i]))) {
      fail('STALE_ARTIFACT', 'Source path identity changed during snapshot read')
    }
    assertUtf8(bytes)
    const artifact = Object.freeze({
      source, sha256, rawSha256: sha256,
      instructionSha256: computeInstructionSha256(bytes),
      totalBytes: bytes.length, assurance: 'portable-snapshot',
      get bytes() { return Buffer.from(bytes) },
    })
    snapshots.set(artifact, bytes)
    return artifact
  } catch (error) {
    if (error instanceof ReviewArtifactError) throw error
    fail(handle ? 'STALE_ARTIFACT' : 'UNSAFE_SOURCE', 'Source could not be safely captured')
  } finally {
    if (handle) await handle.close()
  }
}

/** Byte offsets, never character offsets. Pages are copies and may be replayed.
 * Delivery coverage/accounting belongs to the bound input service, not here. */
export function readArtifactPage(artifact, offset = 0, maxBytes = MAX_PAGE_BYTES) {
  const original = snapshots.get(artifact)
  if (!original) fail('INVALID_ARTIFACT', 'Expected a captured artifact')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > original.length ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > MAX_PAGE_BYTES ||
      (offset < original.length && (original[offset] & 0xc0) === 0x80)) {
    fail('INVALID_PAGE', 'Expected a UTF-8 boundary offset and a byte limit from 4 to 16384')
  }
  let end = Math.min(offset + maxBytes, original.length)
  while (end < original.length && (original[end] & 0xc0) === 0x80) end--
  const bytes = Buffer.from(original.subarray(offset, end))
  return Object.freeze({ offset, nextOffset: end, totalBytes: original.length, done: end === original.length, text: bytes.toString('utf8'), bytes })
}

/** Reopen/re-hash live bytes; inode/size alone never establishes freshness.
 * Raw mode is for handoff; instruction mode is for an already granted lease.
 * Atomic tick replacements may change the inode but not instruction identity. */
export async function revalidateReviewArtifact(artifact, { mode = 'raw' } = {}) {
  if (!snapshots.has(artifact) || !['raw', 'instruction'].includes(mode)) fail('INVALID_ARTIFACT', 'Expected a captured artifact and raw/instruction mode')
  try {
    const current = await createReviewArtifact({ workspace: artifact.source.workspace, target: artifact.source.relativePath })
    const valid = mode === 'raw' ? current.sha256 === artifact.sha256 : current.instructionSha256 === artifact.instructionSha256
    return Object.freeze({ valid, stale: !valid, sha256: current.sha256, instructionSha256: current.instructionSha256 })
  } catch (error) {
    if (!(error instanceof ReviewArtifactError)) throw error
    return Object.freeze({ valid: false, stale: true, code: error.code })
  }
}
