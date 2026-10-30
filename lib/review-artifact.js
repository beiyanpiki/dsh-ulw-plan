/** Immutable review input. This is a portable-snapshot, NOT an openat ancestor-fd
 * chain: adversarial ancestor swaps restored between checks cannot be excluded.
 * Nothing here writes the source, persists plan bytes, or emits global logs. */
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { parseRows } from '../skills/ulw-execute/scripts/plan-state.mjs'

export const MAX_PAGE_BYTES = 16 * 1024
// The canonical plan slug grammar owned by lib/review-lint.js: lowercase
// alphanumerics joined by single hyphens, 1..80 characters.
const MAX_PLAN_SLUG_LENGTH = 80
const snapshots = new WeakMap()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const TASK_SECTION_KINDS = new Map([['todos', 'todo'], ['final verification wave', 'final']])

/** The ATX heading grammar of skills/ulw-execute/scripts/plan-state.mjs: column zero,
 * 1-6 hashes, an optional [ \t]+ title, and ATX closing hashes are metadata rather
 * than title text. A non-heading line (including an indented heading-like line) is
 * null, so it can never open or close a task section. */
function headingOf(line) {
  const match = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(line)
  if (match === null) return null
  const title = (match[2] ?? '').replace(/\r$/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()
  return { level: match[1].length, title }
}

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

// The context grammar of skills/ulw-execute/scripts/plan-state.mjs. This scan must
// classify every line exactly as the execution parser does: a closed frontmatter block
// is metadata, a BOM at byte 0 is metadata, and fences/comments use the same rules.
// plan-state is a standalone script with no imports, so its small regex grammar is
// mirrored here rather than shared; lib/review-lint.js consumes the HTML tracker below.
const TICK = String.fromCharCode(96)
const FENCE_OPEN_RE = /^( {0,3})(\x60{3,}|~{3,})(.*)$/
const FENCE_CLOSE_RE = /^( {0,3})(\x60{3,}|~{3,})[ \t]*$/

function fenceOpening(line) {
  const match = FENCE_OPEN_RE.exec(line)
  if (match === null) return null
  // Backtick info strings may not themselves contain a backtick.
  if (match[2][0] === TICK && match[3].includes(TICK)) return null
  return { char: match[2][0], length: match[2].length }
}

function fenceClosing(line, fence) {
  const match = FENCE_CLOSE_RE.exec(line)
  return match !== null && match[2][0] === fence.char && match[2].length >= fence.length
}

// plan-state opens a comment when the line has an unclosed "<!--" pair, wherever it
// starts. It does not care about block quotes: a quoted comment opener opens a comment
// for execution too, and a quoted "-->" closes it.
function opensHtmlComment(line) {
  let index = 0
  for (;;) {
    const start = line.indexOf('<!--', index)
    if (start === -1) return false
    const end = line.indexOf('-->', start + 4)
    if (end === -1) return true
    index = end + 3
  }
}

/** The 1-based last metadata line of a leading closed "---" block, or 0 when the
 * document has no frontmatter. Exactly plan-state's frontmatterLineLimit: the first
 * line may carry a BOM anywhere (plan-state removes the first one) and is trimmed; an
 * unterminated opener is ordinary content. */
function frontmatterLineLimit(texts) {
  if (texts.length === 0) return 0
  if (texts[0].replace(/\uFEFF/, '').trim() !== '---') return 0
  for (let index = 1; index < texts.length; index += 1) {
    if (texts[index].trim() === '---') return index + 1
  }
  return 0
}

// The HTML-block layer is the one contextual exclusion that is intentionally stricter
// than plan-state: a canonical section/row inside an HTML block is prose for this
// scan, and lib/review-lint.js refuses such plans (SECTION_HTML_BLOCK /
// TASK_ROW_HTML_BLOCK), so a plan-state-accepted tick can never reach a hidden row in
// a lint-valid plan. The tracker is exported and imported by review-lint.js: both
// parsers must run this exact state machine, never a drifting copy.
const VOID_HTML_TAGS = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i
const HTML_CONTAINER_RE = /^ {0,3}<([a-z][a-z0-9-]*)(?=[\s>])/i
const HTML_SELF_CLOSING_RE = /\/\s*>\s*$/

/** For each line, is the instruction scan inside an HTML block while processing it?
 * A trailing CR is tolerated (both callers already split on LF); fences hide
 * HTML-shaped text, comment spans are masked to spaces, and a comment that closes
 * mid-line can reveal a tag that follows it. */
export function instructionHtmlLines(lines) {
  const hidden = new Array(lines.length).fill(false)
  let fence = null
  let comment = false
  let html = null
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (fence !== null) {
      if (fenceClosing(line, fence)) fence = null
      continue
    }
    if (!comment && html === null) {
      const opening = fenceOpening(line)
      if (opening !== null) {
        fence = opening
        continue
      }
    }
    hidden[index] = html !== null
    if (/^ {0,3}>/.test(line)) continue
    // Replace comment spans with spaces, retaining byte-column-zero eligibility.
    let visible = ''
    for (let cursor = 0; cursor < line.length;) {
      if (comment) {
        const close = line.indexOf('-->', cursor)
        if (close < 0) { visible += ' '.repeat(line.length - cursor); break }
        visible += ' '.repeat(close + 3 - cursor)
        cursor = close + 3
        comment = false
      } else {
        const open = line.indexOf('<!--', cursor)
        if (open < 0) { visible += line.slice(cursor); break }
        visible += line.slice(cursor, open) + '    '
        cursor = open + 4
        comment = true
      }
    }
    const container = HTML_CONTAINER_RE.exec(visible)
    const nested = html || (container !== null && !VOID_HTML_TAGS.test(container[1]) && !HTML_SELF_CLOSING_RE.test(visible) ? { tag: container[1], depth: 0 } : null)
    if (nested !== null) {
      const tags = new RegExp('</?' + nested.tag + '(?=[\\s>])[^>]*>', 'gi')
      for (const tag of visible.matchAll(tags)) {
        if (!/\/\s*>$/.test(tag[0])) nested.depth += tag[0][1] === '/' ? -1 : 1
      }
      html = nested.depth > 0 ? nested : null
      continue
    }
    const opening = fenceOpening(visible)
    if (opening !== null) fence = opening
  }
  return hidden
}

/** Normalize ONLY status bytes of unambiguous, section-local top-level tasks.
 * The existing tick grammar supplies row recognition; the context machine is
 * plan-state's exactly (frontmatter, BOM, comment/quote/fence state), so every tick
 * execution accepts keeps instruction identity. The HTML-block layer stays stricter
 * than execution and is mirrored by lint's refusal. Every write is verified against
 * the raw line bytes first: parser calls may ignore a prefix (the section-aware
 * parser strips a line-leading BOM), so a computed offset is never trusted. */
export function computeInstructionSha256(content) {
  const bytes = asBytes(content)
  assertUtf8(bytes)
  const lines = []
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start)
    const end = newline < 0 ? bytes.length : newline
    const raw = bytes.subarray(start, end).toString('utf8')
    lines.push({ start, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw })
    start = end + 1
  }
  const texts = lines.map(line => line.text)
  const frontEnd = frontmatterLineLimit(texts)
  const hidden = instructionHtmlLines(texts)
  let section = null
  let fence = null
  let comment = false
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // A UTF-8 BOM is metadata only at byte 0; plan-state keeps its bytes in every row
    // offset and never lets a BOM-prefixed row execute.
    const bom = index === 0 && line.text.charCodeAt(0) === 0xfeff
    const text = bom ? line.text.slice(1) : line.text
    let structural = index < frontEnd
    if (!structural && fence !== null) {
      if (fenceClosing(text, fence)) fence = null
      structural = true
    } else if (!structural && comment) {
      // The whole line on which a comment closes is structural, exactly like
      // plan-state: its remainder can never open a fence or become a row.
      if (text.includes('-->')) comment = false
      structural = true
    } else if (!structural) {
      const opening = fenceOpening(text)
      if (opening !== null) {
        fence = opening
        structural = true
      } else if (opensHtmlComment(text)) {
        comment = true
      }
    }
    // HTML-block content is prose for this scan: it never opens/closes a section and
    // never contributes a row. Lint refuses plans where that would hide a canonical
    // task marker, so this strictness is fail-closed rather than divergent.
    if (structural || hidden[index]) continue
    const heading = headingOf(text)
    if (heading !== null) {
      // Same section model as plan-state.mjs: only a column-zero H1/H2 opens or closes
      // a task section, the two canonical H2 titles are matched case-insensitively,
      // and H3+ headings keep the section open. An indented or otherwise
      // non-column-zero heading-like line is ordinary text.
      if (heading.level <= 2) {
        section = heading.level === 2 ? (TASK_SECTION_KINDS.get(heading.title.toLowerCase()) ?? null) : null
      }
      continue
    }
    if (bom || section === null) continue
    const row = parseRows(text)[0]
    if (row === undefined || !(section === 'todo' ? /^[1-9]\d*$/.test(row.id) : /^F[1-9]\d*$/.test(row.id))) continue
    // Never write at a computed offset without checking the raw bytes. A parser may
    // strip a prefix (a BOM on a per-line call), so require the raw line to start with
    // exactly "- [<status>] " and verify the status byte and its brackets.
    const status = bytes[line.start + 3]
    const canonical = bytes[line.start] === 0x2d && bytes[line.start + 1] === 0x20 &&
      bytes[line.start + 2] === 0x5b && bytes[line.start + 4] === 0x5d &&
      (status === 0x20 || status === 0x78 || status === 0x7e) &&
      status === row.status.charCodeAt(0)
    rows.push({ id: row.id, offset: line.start + 3, canonical })
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
  const match = /^\.dsh\/ulw\/plans\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(rel.split(sep).join('/'))
  const path = join(workspace, rel)
  if (!match || match[1].length > MAX_PLAN_SLUG_LENGTH || target !== (isAbsolute(target) ? path : rel) || rel !== join('.dsh', 'ulw', 'plans', match[1] + '.md')) {
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
