/** Pure, deterministic structural preflight for ulw work plans.
 *
 * Structural only: this module parses a plan as DATA. It never executes a plan
 * command, never rewrites the plan, and never claims semantic review. Its job is to
 * say, with exact line numbers, whether a plan has the canonical shape a bound
 * reviewer can consume - and to keep to-be-created modules, evidence paths, globs
 * and URLs from being mistaken for missing citations.
 *
 * Boundary classification matches skills/ulw-execute/scripts/plan-state.mjs: column-zero
 * checklist rows only, fences with info strings, HTML comments, block quotes, indented
 * and nested lines never contribute rows, and a task section is opened at heading level
 * 1-2 only. This module is stricter where review binding is at stake (BOM rows, ATX
 * closing hashes, setext headings), because the bound reader in lib/review-artifact.js
 * refuses those bytes as task rows. Invalid UTF-8 is refused with the stable
 * INVALID_UTF8 code instead of being decoded through replacement characters: lint must
 * fail closed, because lib/review-artifact.js refuses those same bytes.
 *
 * Canonical plan slug grammar (the single grammar a reviewable plan may use):
 *     ^[a-z0-9]+(?:-[a-z0-9]+)*$   with 1..80 characters
 * It is the intersection of lib/review-protocol.js targetPath (no leading, trailing or
 * doubled hyphen) and lib/review-artifact.js lexicalSource (at most 80 chars): no other
 * shape can be bound for review. skills/ulw-plan/scripts/scaffold-plan.mjs is looser -
 * it accepts "a--b" and "a-" - so such a scaffolded plan is silently unreviewable.
 * SLUG_NOT_CANONICAL reports that mismatch at preflight time instead of at handoff.
 * SLUG_MISSING reports a target under .dsh/ulw/plans/ whose filename carries no slug
 * at all (for example .dsh/ulw/plans/.md); such a target can never be bound, so it is
 * refused structurally instead of being linted as if it were an arbitrary fixture.
 *
 * Exit contract lives in skills/ulw-plan/scripts/plan-lint.mjs: 0 valid, 2 structural
 * invalid, 5 usage/IO.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { PLAN_SECTION_HEADERS } from '../skills/ulw-plan/scripts/plan-templates.mjs'

const TICK = String.fromCharCode(96)
const INLINE_CODE_RE = new RegExp(TICK + '([^' + TICK + ']*)' + TICK, 'g')

const SECTION_TITLES = PLAN_SECTION_HEADERS.map(header => header.replace(/^## /, ''))
const SECTION_INDEX = new Map(SECTION_TITLES.map((title, index) => [title.toLowerCase(), index]))
const SECTION_TASK_KIND = new Map([['todos', 'todos'], ['final verification wave', 'final']])
const REQUIRED_SECTIONS = ['Todos', 'Final verification wave']
const PLAN_CATEGORIES = Object.freeze(['quick', 'unspecified-low', 'unspecified-high', 'visual-engineering', 'writing', 'git', 'deep-low', 'deep-high', 'ultrabrain'])
const MAX_SLUG_LENGTH = 80

export const CANONICAL_PLAN_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const HEADING_RE = /^(#{1,6})(?:[ \t]+(.*))?$/
const CLOSING_HASH_RE = /[ \t]+#+[ \t]*$/
const FENCE_RUN = '(' + TICK + '{3,}|~{3,})'
const FENCE_OPEN_RE = new RegExp('^( {0,3})' + FENCE_RUN + '(.*)$')
const FENCE_CLOSE_RE = new RegExp('^( {0,3})' + FENCE_RUN + '[ \\t]*$')
const ROW_RE = /^- \[([ x~])\] (\d+|F\d+)\. /
const CHECKBOX_RE = /^- \[[ x~]\] (.*)$/
const TASKISH_RE = /^(?:F-?\d|\d+[.)][ \t]|\d+[ \t]|\d+$)/
const NESTED_ROW_RE = /^[ \t]+- \[[ x~]\] (?:\d+|F\d+)\. /
const QUOTED_ROW_RE = /^ {0,3}> ?- \[[ x~]\] (?:\d+|F\d+)\. /
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/
const BOM = String.fromCharCode(0xfeff)
const BACKSLASH = String.fromCharCode(92)

const SLOT_PATTERNS = Object.freeze([
  ['category', /^Recommended task executor category[ \t]*:[ \t]*(.*)$/],
  ['action', /^What to do \/ Must NOT do[ \t]*:[ \t]*(.*)$/],
  ['closes', /^Closes[ \t]*:[ \t]*(.*)$/],
  ['parallelization', /^Parallelization[ \t]*:[ \t]*(.*)$/],
  ['references', /^References\b[^:]*:[ \t]*(.*)$/],
  ['acceptance', /^Acceptance criteria\b[^:]*:[ \t]*(.*)$/],
  ['qa', /^QA scenarios\b[^:]*:[ \t]*(.*)$/],
  ['commit', /^Commit[ \t]*:[ \t]*(.*)$/],
])
// Every task row carries the executor category plus machine-checkable acceptance and
// QA. A Todos row additionally carries its source references and its commit plan; a
// final-wave row verifies landed work, so it inherits neither (the canonical template
// emits final-wave rows without them).
const REQUIRED_SLOTS = Object.freeze([
  ['category', 'TASK_CATEGORY_MISSING'],
  ['acceptance', 'TASK_ACCEPTANCE_MISSING'],
  ['qa', 'TASK_QA_MISSING'],
])
const IMPLEMENTATION_SLOTS = Object.freeze([
  ['references', 'TASK_REFERENCES_MISSING'],
  ['commit', 'TASK_COMMIT_MISSING'],
])
const OPTIONAL_SLOTS = Object.freeze([
  ['action', 'TASK_ACTION_MISSING'],
  ['closes', 'TASK_CLOSES_MISSING'],
  ['parallelization', 'TASK_PARALLELIZATION_MISSING'],
])

export const ERROR_CODES = Object.freeze([
  'INVALID_UTF8',
  'SECTION_MISSING', 'SECTION_ORDER', 'SECTION_DUPLICATE',
  'HEADING_SETEXT', 'HEADING_CLOSING_HASH',
  'TASK_ROW_BOM', 'TASK_ROW_MALFORMED', 'TASK_ID_INVALID', 'TASK_ID_DUPLICATE',
  'TASK_SECTION_MISMATCH', 'TASK_ROW_OUTSIDE_SECTION',
  'TASK_CATEGORY_MISSING', 'TASK_REFERENCES_MISSING', 'TASK_ACCEPTANCE_MISSING',
  'TASK_QA_MISSING', 'TASK_COMMIT_MISSING',
  'REFERENCE_MISSING_EXISTING', 'GAP_UNKNOWN', 'IS_MAPPING_UNKNOWN', 'SLUG_MISSING', 'SLUG_NOT_CANONICAL',
])
export const WARNING_CODES = Object.freeze([
  'SECTION_UNKNOWN', 'HEADING_NESTED_IN_TASKS',
  'TASK_ROW_FENCED', 'TASK_ROW_QUOTED', 'TASK_ROW_INDENTED', 'TASK_ROW_COMMENTED',
  'CHECKBOX_UNNUMBERED', 'TASK_ACTION_MISSING', 'TASK_CLOSES_MISSING',
  'TASK_PARALLELIZATION_MISSING', 'TASK_CATEGORY_UNKNOWN', 'TASK_COMMIT_FORMAT',
  'REFERENCE_UNRESOLVED', 'GAP_UNMAPPED',
])
export const PLAN_LINT_CODES = Object.freeze([...ERROR_CODES, ...WARNING_CODES])

const SEVERITY = new Map([
  ...ERROR_CODES.map(code => [code, 'error']),
  ...WARNING_CODES.map(code => [code, 'warning']),
])

export function isCanonicalPlanSlug(slug) {
  return typeof slug === 'string' && slug.length >= 1 && slug.length <= MAX_SLUG_LENGTH && CANONICAL_PLAN_SLUG_RE.test(slug)
}

/** The slug of a plan under .dsh/ulw/plans/: '' when that target carries no slug,
 * else null when the path is not a plans target (arbitrary fixtures carry no slug). */
export function planSlugFromPath(path) {
  if (typeof path !== 'string' || path === '') return null
  const normalized = path.split(BACKSLASH).join('/')
  const match = /(?:^|\/)\.dsh\/ulw\/plans\/([^/]*)\.md$/.exec(normalized)
  return match === null ? null : match[1]
}

/** Stable refusal for byte-level inputs that are not valid UTF-8. */
export class ReviewLintError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReviewLintError'
    this.code = code
  }
}

// ignoreBOM keeps the exact bytes visible to the scanner (Buffer.toString does not
// strip a leading BOM either), so TASK_ROW_BOM and section detection stay unchanged.
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function decodeUtf8(bytes) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new ReviewLintError('INVALID_UTF8', 'plan bytes are not valid UTF-8')
  }
}

function asBuffer(content) {
  if (Buffer.isBuffer(content)) return Buffer.from(content)
  if (typeof content === 'string') return Buffer.from(content, 'utf8')
  throw new TypeError('plan content must be a string or a Buffer')
}

function splitLines(bytes) {
  return decodeUtf8(asBuffer(bytes)).split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function headingOf(text) {
  const match = HEADING_RE.exec(text)
  if (match === null) return null
  const rawTitle = match[2] === undefined ? '' : match[2]
  return { level: match[1].length, title: rawTitle.replace(/[ \t]+#+[ \t]*$/, '').trim(), closing: CLOSING_HASH_RE.test(rawTitle) }
}

function fenceOpening(text) {
  const match = FENCE_OPEN_RE.exec(text)
  if (match === null) return null
  if (match[2][0] === TICK && match[3].includes(TICK)) return null
  return { char: match[2][0], length: match[2].length }
}

function fenceClosing(text, fence) {
  const match = FENCE_CLOSE_RE.exec(text)
  return match !== null && match[2][0] === fence.char && match[2].length >= fence.length
}

function opensHtmlComment(text) {
  let index = 0
  for (;;) {
    const start = text.indexOf('<!--', index)
    if (start === -1) return false
    const end = text.indexOf('-->', start + 4)
    if (end === -1) return true
    index = end + 3
  }
}

function frontMatterEnd(lines) {
  if (lines.length === 0) return 0
  if (lines[0].replace(BOM, '').trim() !== '---') return 0
  for (let index = 1; index < lines.length; index += 1) if (lines[index].trim() === '---') return index + 1
  return 0
}

function checklistShape(text) {
  const row = ROW_RE.exec(text)
  if (row !== null) return { id: row[2], canonical: true }
  const box = CHECKBOX_RE.exec(text)
  if (box !== null && TASKISH_RE.test(box[1])) {
    const id = /^(?:F-?\d+|\d+)/.exec(box[1])
    return { id: id === null ? '' : id[0], canonical: false }
  }
  return null
}

/** Scan the document once and collect the structural model plus its diagnostics. */
function scanPlan(content) {
  const lines = splitLines(content)
  const frontEnd = frontMatterEnd(lines)
  const diagnostics = []
  const add = (code, line, taskId, message) => diagnostics.push({ code, severity: SEVERITY.get(code), line, taskId, message })
  const sections = []
  const rows = []
  const shadowed = []
  const gaps = []
  const successRows = []
  const kinds = new Array(lines.length)
  let fence = null
  let comment = false
  let current = null
  let sawLevel2 = false
  let lastCanonical = -1
  let previousKind = 'blank'
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1
    const raw = lines[index]
    const bom = raw.startsWith(BOM)
    const text = index === 0 && bom ? raw.slice(1) : raw
    if (number <= frontEnd) {
      kinds[index] = 'frontmatter'
      previousKind = 'frontmatter'
      continue
    }
    if (fence !== null) {
      const shape = checklistShape(text)
      if (shape !== null) {
        shadowed.push({ kind: 'fenced', line: number, id: shape.id })
        add('TASK_ROW_FENCED', number, shape.id, 'task row inside a fenced code block is an example, never an executable row')
      }
      if (fenceClosing(text, fence)) fence = null
      kinds[index] = 'fence'
      previousKind = 'fence'
      continue
    }
    if (comment) {
      const shape = checklistShape(text)
      if (shape !== null) {
        shadowed.push({ kind: 'comment', line: number, id: shape.id })
        add('TASK_ROW_COMMENTED', number, shape.id, 'task row inside an HTML comment is prose, never an executable row')
      }
      if (text.includes('-->')) comment = false
      kinds[index] = 'comment'
      previousKind = 'comment'
      continue
    }
    const opening = fenceOpening(text)
    if (opening !== null) {
      fence = opening
      kinds[index] = 'fence'
      previousKind = 'fence'
      continue
    }
    if (opensHtmlComment(text)) comment = true
    kinds[index] = 'content'
    if (bom) {
      const shape = checklistShape(index === 0 ? text : raw.slice(1))
      if (shape !== null) {
        add('TASK_ROW_BOM', number, shape.id, 'byte-order mark precedes a task row, so the row is never reviewable')
        previousKind = 'row'
        continue
      }
    }
    const heading = headingOf(text)
    if (heading !== null) {
      previousKind = 'heading'
      if (heading.closing) add('HEADING_CLOSING_HASH', number, '', 'ATX heading carries closing hashes; canonical plans use a bare "## <section>" heading')
      if (heading.level > 2) {
        if (current !== null && SECTION_TASK_KIND.has(current.toLowerCase())) add('HEADING_NESTED_IN_TASKS', number, '', 'nested heading inside the "' + current + '" task section does not open a new section')
      } else if (heading.level === 1) {
        current = null
      } else {
        sawLevel2 = true
        const canonical = SECTION_INDEX.get(heading.title.toLowerCase())
        if (canonical === undefined) {
          current = null
          add('SECTION_UNKNOWN', number, '', 'non-canonical H2 section "' + heading.title + '"')
        } else {
          const title = SECTION_TITLES[canonical]
          if (sections.some(section => section.index === canonical)) add('SECTION_DUPLICATE', number, '', 'duplicate canonical section "## ' + title + '"')
          else if (lastCanonical > canonical) add('SECTION_ORDER', number, '', 'section "## ' + title + '" is out of canonical order')
          if (lastCanonical < canonical) lastCanonical = canonical
          sections.push({ index: canonical, title, line: number })
          current = title
        }
      }
      continue
    }
    if (SETEXT_RE.test(text) && previousKind === 'text') {
      add('HEADING_SETEXT', number, '', 'setext heading underline is not a canonical heading; use an ATX "## <section>" heading')
      previousKind = 'hr'
      continue
    }
    const row = ROW_RE.exec(text)
    if (row !== null) {
      rows.push({ id: row[2], kind: row[2].startsWith('F') ? 'F' : 'N', line: number, section: current })
      previousKind = 'row'
      continue
    }
    const box = CHECKBOX_RE.exec(text)
    if (box !== null) {
      if (TASKISH_RE.test(box[1])) add('TASK_ROW_MALFORMED', number, '', 'column-zero checklist line is not a canonical "- [ ] <id>. <title>" task row')
      else if (current !== null && SECTION_TASK_KIND.has(current.toLowerCase())) add('CHECKBOX_UNNUMBERED', number, '', 'checklist line inside "' + current + '" has no canonical task id')
      previousKind = 'row'
      continue
    }
    if (NESTED_ROW_RE.test(text)) {
      add('TASK_ROW_INDENTED', number, '', 'indented task row never executes; expected a column-zero "- [ ] <id>. <title>" row')
      previousKind = 'list'
      continue
    }
    if (QUOTED_ROW_RE.test(text)) {
      add('TASK_ROW_QUOTED', number, '', 'quoted task row is prose, never an executable row')
      previousKind = 'quote'
      continue
    }
    if (/^ {0,3}>/.test(text)) {
      previousKind = 'quote'
      continue
    }
    if (SETEXT_RE.test(text)) {
      previousKind = 'hr'
      continue
    }
    if (text.trim().startsWith('|')) {
      const cells = text.split('|').map(cell => cell.trim())
      const first = cells.length > 1 ? cells[1] : ''
      if (/^GAP-\d+$/.test(first)) gaps.push({ id: first, line: number })
      else if (/^IS-\d+$/.test(first) && current === 'Success criteria') successRows.push({ id: first, line: number, cell: cells.length > 2 ? cells[2] : '' })
      previousKind = 'table'
      continue
    }
    if (/^[ \t]*([-*+]|\d+[.)])[ \t]/.test(text)) {
      previousKind = 'list'
      continue
    }
    previousKind = text.trim() === '' ? 'blank' : 'text'
  }
  return { lines, kinds, sections, rows, shadowed, gaps, successRows, diagnostics, hasH2: sawLevel2 }
}

/** Lines owned by one task row: indented, non-blank content before the next row. */
function taskBlock(lines, kinds, lineNumber) {
  const block = []
  for (let index = lineNumber; index < lines.length; index += 1) {
    const line = lines[index]
    if (kinds[index] !== 'content') break
    if (line.trim() === '') break
    if (!/^[ \t]/.test(line)) break
    block.push({ line: index + 1, text: line })
  }
  return block
}

function parseSlots(block) {
  const slots = new Map()
  for (const entry of block) {
    const text = entry.text.trim()
    for (const pair of SLOT_PATTERNS) {
      const match = pair[1].exec(text)
      if (match === null) continue
      if (!slots.has(pair[0])) slots.set(pair[0], { line: entry.line, value: match[1].trim() })
      break
    }
  }
  return slots
}

function referenceTokens(value) {
  const paths = []
  let rest = value.replace(/\[[^\]]*\]\(<?([^)>]+)>?\)/g, (match, target) => {
    paths.push(target)
    return ' '.repeat(match.length)
  })
  rest = rest.replace(INLINE_CODE_RE, (match, inner) => {
    paths.push(inner)
    return ' '.repeat(match.length)
  })
  const prose = []
  for (const match of rest.matchAll(/(?<![A-Za-z0-9_-])([A-Z]{1,3}-?\d+)(?![A-Za-z0-9_-])/g)) prose.push(match[1])
  return { paths, prose }
}

/** Split a reference token into an existing citation, a declared target, or prose. */
function classifyReference(token, workspace) {
  const value = token.trim().replace(/^</, '').replace(/>$/, '')
  if (value === '') return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { kind: 'url' }
  if (value.startsWith('$') || value.includes('<') || value.includes('>')) return { kind: 'target' }
  if (/[*?[]/.test(value)) return { kind: 'glob' }
  if (/\s/.test(value)) return { kind: 'command' }
  if (isAbsolute(value)) return { kind: 'absolute' }
  const coordinates = /:\d+(?:-\d+)?$/.test(value) || /#L\d+(?:-L\d+)?$/.test(value)
  const bare = value.replace(/:\d+(?:-\d+)?$/, '').replace(/#L\d+(?:-L\d+)?$/, '')
  const pathLike = bare.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(bare)
  if (!pathLike) return { kind: 'prose', token: value }
  if (workspace === undefined) return { kind: 'unchecked' }
  if (existsSync(join(workspace, bare))) return { kind: 'existing' }
  return { kind: coordinates ? 'missing' : 'unresolved', token: value }
}

function analyzeTask(task, block, workspace, add) {
  const slots = parseSlots(block)
  for (const pair of REQUIRED_SLOTS) {
    if (!slots.has(pair[0]) || slots.get(pair[0]).value === '') add(pair[1], task.line, task.id, 'task ' + task.id + ' is missing the required slot: ' + pair[0])
  }
  if (task.kind === 'N') {
    for (const pair of IMPLEMENTATION_SLOTS) {
      if (!slots.has(pair[0]) || slots.get(pair[0]).value === '') add(pair[1], task.line, task.id, 'task ' + task.id + ' is missing the required slot: ' + pair[0])
    }
  }
  for (const pair of OPTIONAL_SLOTS) {
    if (!slots.has(pair[0]) || slots.get(pair[0]).value === '') add(pair[1], task.line, task.id, 'task ' + task.id + ' is missing the canonical slot: ' + pair[0])
  }
  const category = slots.get('category')
  if (category !== undefined && category.value !== '') {
    const name = /^[a-z][a-z-]*/.exec(category.value)
    if (name === null || !PLAN_CATEGORIES.includes(name[0])) add('TASK_CATEGORY_UNKNOWN', category.line, task.id, 'task ' + task.id + ' has an unknown executor category: ' + JSON.stringify(category.value.split(/\s+/)[0]))
  }
  const commit = slots.get('commit')
  if (commit !== undefined && commit.value !== '' && !/^[YN]\b/.test(commit.value)) add('TASK_COMMIT_FORMAT', commit.line, task.id, 'task ' + task.id + ' commit slot must start with Y or N')
  const closes = slots.get('closes')
  const result = { slots, closes: closes === undefined ? [] : closes.value.match(/GAP-\d+/g) || [] }
  const references = slots.get('references')
  if (references === undefined) return result
  const tokens = referenceTokens(references.value)
  for (const token of tokens.paths) {
    const classified = classifyReference(token, workspace)
    if (classified === null) continue
    if (classified.kind === 'missing') add('REFERENCE_MISSING_EXISTING', references.line, task.id, 'task ' + task.id + ' cites a line-addressed source that does not exist: ' + classified.token)
    else if (classified.kind === 'unresolved') add('REFERENCE_UNRESOLVED', references.line, task.id, 'task ' + task.id + ' reference is neither an existing source nor a declared target: ' + classified.token)
  }
  for (const token of tokens.prose) add('REFERENCE_UNRESOLVED', references.line, task.id, 'task ' + task.id + ' uses an unverifiable prose reference: ' + token)
  return result
}

function splitTasks(scan) {
  const flat = !scan.hasH2
  const tasks = []
  const outOfSection = []
  for (const row of scan.rows) {
    const kind = SECTION_TASK_KIND.get(String(row.section).toLowerCase())
    if (kind !== undefined) tasks.push({ ...row, section: kind })
    else if (flat) tasks.push({ ...row, section: 'flat' })
    else outOfSection.push(row)
  }
  return { tasks, outOfSection }
}

/** Pure structural model of a plan document. Never touches the filesystem. */
export function parsePlanDocument(content) {
  const scan = scanPlan(content)
  const { tasks, outOfSection } = splitTasks(scan)
  return {
    hasH2: scan.hasH2,
    sections: scan.sections.map(section => ({ title: section.title, line: section.line })),
    tasks,
    outOfSection,
    shadowed: scan.shadowed,
    counts: {
      tasks: tasks.length,
      todos: tasks.filter(task => task.section === 'todos').length,
      final: tasks.filter(task => task.section === 'final').length,
      shadowed: scan.shadowed.length,
    },
  }
}

/** Structural preflight. Returns { valid, diagnostics, sha256 } and writes nothing.
 * workspace enables existence checks for line-addressed source citations; when it is
 * omitted the lint stays a pure syntax check and resolves no reference on disk. */
export function lintPlan(input) {
  const options = input === undefined || input === null ? {} : input
  const bytes = asBuffer(options.content === undefined ? '' : options.content)
  const workspace = options.workspace === undefined || options.workspace === null ? undefined : String(options.workspace)
  // Refusal order: path shape, then byte encoding, then document structure. A plans
  // target with no slug is unusable whatever its bytes are, so it is refused before any
  // content is decoded; every other target still decodes fatally below. Both refusals
  // are fail-closed: valid=false, error severity, and sha256 of the exact bytes.
  const planSlug = planSlugFromPath(options.path)
  if (planSlug === '') {
    // A plans-directory target with no slug can never be bound for review. Refuse it
    // as a structural path error instead of validating content that cannot be used.
    return {
      valid: false,
      diagnostics: [{
        code: 'SLUG_MISSING',
        severity: SEVERITY.get('SLUG_MISSING'),
        line: 0,
        taskId: '',
        message: 'plan target has no slug; review can bind only .dsh/ulw/plans/<canonical-slug>.md',
      }],
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  try {
    decodeUtf8(bytes)
  } catch (error) {
    if (!(error instanceof ReviewLintError)) throw error
    return {
      valid: false,
      diagnostics: [{
        code: error.code,
        severity: SEVERITY.get(error.code),
        line: 0,
        taskId: '',
        message: 'plan bytes are not valid UTF-8; lint refuses them instead of guessing',
      }],
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  const scan = scanPlan(bytes)
  const diagnostics = scan.diagnostics.slice()
  const add = (code, line, taskId, message) => diagnostics.push({ code, severity: SEVERITY.get(code), line, taskId, message })
  const { tasks, outOfSection } = splitTasks(scan)
  for (const section of REQUIRED_SECTIONS) {
    if (!scan.sections.some(entry => entry.title === section)) add('SECTION_MISSING', 0, '', 'required canonical section is missing: "## ' + section + '"')
  }
  for (const row of outOfSection) add('TASK_ROW_OUTSIDE_SECTION', row.line, row.id, 'task ' + row.id + ' is outside "## Todos" and "## Final verification wave"')
  const seen = new Map()
  for (const task of tasks) {
    const canonicalId = task.kind === 'F' ? /^F[1-9]\d*$/.test(task.id) : /^[1-9]\d*$/.test(task.id)
    if (!canonicalId) add('TASK_ID_INVALID', task.line, task.id, 'task id ' + JSON.stringify(task.id) + ' is not a canonical ' + (task.kind === 'F' ? 'final-wave F id' : 'positive integer N id'))
    if (seen.has(task.id)) add('TASK_ID_DUPLICATE', task.line, task.id, 'task id ' + JSON.stringify(task.id) + ' duplicates the row at line ' + seen.get(task.id))
    else seen.set(task.id, task.line)
    if (task.section === 'todos' && task.kind === 'F') add('TASK_SECTION_MISMATCH', task.line, task.id, 'final-wave id ' + task.id + ' belongs in "## Final verification wave", not "## Todos"')
    if (task.section === 'final' && task.kind === 'N') add('TASK_SECTION_MISMATCH', task.line, task.id, 'todo id ' + task.id + ' belongs in "## Todos", not "## Final verification wave"')
  }
  const closedGaps = new Set()
  const declaredGaps = new Map(scan.gaps.map(gap => [gap.id, gap.line]))
  for (const task of tasks) {
    const analysis = analyzeTask(task, taskBlock(scan.lines, scan.kinds, task.line), workspace, add)
    for (const gapId of analysis.closes) {
      closedGaps.add(gapId)
      if (!declaredGaps.has(gapId)) add('GAP_UNKNOWN', analysis.slots.get('closes').line, task.id, 'task ' + task.id + ' closes undeclared ' + gapId)
    }
  }
  for (const gap of declaredGaps) {
    if (!closedGaps.has(gap[0])) add('GAP_UNMAPPED', gap[1], '', 'declared ' + gap[0] + ' is not closed by any task')
  }
  const taskIds = new Set(tasks.map(task => task.id))
  for (const row of scan.successRows) {
    for (const token of row.cell.split(/[,\s]+/)) {
      const id = token.trim()
      if (!/^(?:\d+|F\d+)$/.test(id)) continue
      if (!taskIds.has(id)) add('IS_MAPPING_UNKNOWN', row.line, '', row.id + ' maps to a todo id that does not exist: ' + JSON.stringify(id))
    }
  }
  if (planSlug !== null && !isCanonicalPlanSlug(planSlug)) add('SLUG_NOT_CANONICAL', 0, '', 'plan slug ' + JSON.stringify(planSlug) + ' cannot be bound for review; the canonical grammar is ^[a-z0-9]+(?:-[a-z0-9]+)*$ up to 80 characters')
  diagnostics.sort((left, right) => left.line - right.line || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
  return {
    valid: diagnostics.every(diagnostic => diagnostic.severity !== 'error'),
    diagnostics,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
