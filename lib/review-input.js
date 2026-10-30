/**
 * Host-bound paginated plan input for the enhanced dual review lanes.
 *
 * This module owns exactly one model-visible tool, ulw_review_input, whose only
 * parameter is a UTF-8 byte cursor. Everything a reviewer is allowed to read is
 * decided by Host-owned identity: the pre-bound child session id is resolved
 * from exec.agent and looked up in a binding map populated from a captured
 * immutable review-artifact snapshot. A page can never be redirected to another
 * path, lane, session or artifact by model arguments, and an unbound agent -
 * even one that claims a reviewer preset - receives no bytes.
 *
 * Coverage accounting is deliberately split from page serving. execute() only
 * prepares a page and records the exact canonical value plus its rendered
 * projection for that callId. The final tools/result observer is the only place
 * coverage may advance, and only when ALL of the following hold:
 *
 *   1. the final result succeeded (isError === false);
 *   2. the final canonical value still equals the issued page exactly;
 *   3. the model-visible page text parses back to exactly the snapshot bytes in
 *      [byteStart, byteEnd);
 *   4. the final content is the unmodified issued projection - so a
 *      post-execute, finalize, truncation or spill replacement never counts;
 *   5. the issued page starts exactly at the already delivered offset
 *      (contiguous and monotonic); replays advance nothing, gaps credit nothing.
 *
 * Completion is reported through the review-policy seam (recordDelivery), so
 * evidence tools and structured capture only unlock once the whole snapshot has
 * actually reached the model. Incomplete delivery is always reported as
 * INPUT_DELIVERY_INCOMPLETE and can never approve anything.
 *
 * @module dsh-ulw-plan/review-input
 */
import { ReviewArtifactError, readArtifactPage } from './review-artifact.js'
import { REVIEW_INPUT_TOOL, REVIEW_STAGES } from './review-policy.js'
import { REVIEW_LANES } from './review-protocol.js'

/** Successful page delivery observation. */
export const REVIEW_INPUT_DELIVERED = 'REVIEW_INPUT_DELIVERED'
/** The only status an incomplete delivery may report. */
export const REVIEW_INPUT_INCOMPLETE = 'INPUT_DELIVERY_INCOMPLETE'

/** Observable, stable reasons carried by an incomplete delivery observation. */
export const REVIEW_INPUT_REASONS = Object.freeze({
  unbound: 'REVIEW_INPUT_UNBOUND',
  unknownCall: 'REVIEW_INPUT_UNKNOWN_CALL',
  crossLane: 'REVIEW_INPUT_CROSS_LANE',
  resultFailed: 'REVIEW_INPUT_RESULT_FAILED',
  canonicalReplaced: 'REVIEW_INPUT_CANONICAL_REPLACED',
  visibleTextMissing: 'REVIEW_INPUT_VISIBLE_TEXT_MISSING',
  textMismatch: 'REVIEW_INPUT_TEXT_MISMATCH',
  contentReplaced: 'REVIEW_INPUT_CONTENT_REPLACED',
  gap: 'REVIEW_INPUT_GAP',
  policyRefused: 'REVIEW_INPUT_POLICY_REFUSED',
})

/** A refusal or accounting failure owned by the bound input service. */
export class ReviewInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReviewInputError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new ReviewInputError(code, message)
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const sessionIdOf = (agent) => {
  const id = agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

const PAGE_SOURCE_KEYS = Object.freeze(['workspace', 'relativePath', 'sha256', 'instructionSha256'])
const PAGE_KEYS = Object.freeze(['source', 'lane', 'byteStart', 'byteEnd', 'nextCursor', 'totalBytes', 'text', 'done'])

/** The one model-facing parameter. No path, lane, session or coverage field exists. */
export const REVIEW_INPUT_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    cursor: {
      type: 'integer',
      description: 'UTF-8 byte offset of the next page; omit for the first page.',
    },
  },
  additionalProperties: false,
  required: Object.freeze([]),
})

/** Canonical page value schema: every field is Host-derived page metadata. */
export const REVIEW_INPUT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze([...PAGE_KEYS]),
  properties: {
    source: {
      type: 'object',
      additionalProperties: false,
      required: Object.freeze([...PAGE_SOURCE_KEYS]),
      properties: {
        workspace: { type: 'string' },
        relativePath: { type: 'string' },
        sha256: { type: 'string' },
        instructionSha256: { type: 'string' },
      },
    },
    lane: { type: 'string', enum: Object.freeze([...REVIEW_LANES]) },
    byteStart: { type: 'integer' },
    byteEnd: { type: 'integer' },
    nextCursor: { type: 'integer' },
    totalBytes: { type: 'integer' },
    text: { type: 'string' },
    done: { type: 'boolean' },
  },
})

function renderPage(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function parseCursor(args) {
  if (args === undefined || args === null) return 0
  if (!isPlainObject(args)) fail('REVIEW_INPUT_INVALID_ARGUMENTS', 'The only model parameter is an integer byte cursor')
  const keys = Object.keys(args)
  if (keys.length === 0) return 0
  if (keys.length !== 1 || keys[0] !== 'cursor') {
    fail('REVIEW_INPUT_INVALID_ARGUMENTS', 'The only model parameter is cursor; path, lane, session and coverage are Host-owned')
  }
  const cursor = args.cursor
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail('REVIEW_INPUT_INVALID_ARGUMENTS', 'cursor must be a nonnegative safe integer')
  return cursor
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** Compare the final canonical value field-for-field with the issued page. */
function samePageValue(expected, actual) {
  return (
    hasExactKeys(actual, PAGE_KEYS) &&
    hasExactKeys(actual.source, PAGE_SOURCE_KEYS) &&
    actual.source.workspace === expected.source.workspace &&
    actual.source.relativePath === expected.source.relativePath &&
    actual.source.sha256 === expected.source.sha256 &&
    actual.source.instructionSha256 === expected.source.instructionSha256 &&
    actual.lane === expected.lane &&
    actual.byteStart === expected.byteStart &&
    actual.byteEnd === expected.byteEnd &&
    actual.nextCursor === expected.nextCursor &&
    actual.totalBytes === expected.totalBytes &&
    actual.text === expected.text &&
    actual.done === expected.done
  )
}

/** Parse the first model-visible block as the page envelope. */
function visibleEnvelope(content) {
  if (!Array.isArray(content) || content.length === 0) return undefined
  const block = content[0]
  if (!isPlainObject(block) || block.type !== 'text' || typeof block.text !== 'string') return undefined
  let parsed
  try {
    parsed = JSON.parse(block.text)
  } catch {
    return undefined
  }
  return isPlainObject(parsed) ? parsed : undefined
}

/** The final projection must be the unmodified single text block execute prepared. */
function sameContent(expected, actual) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  return expected.every((block, index) => {
    const got = actual[index]
    if (!isPlainObject(got) || got.type !== 'text' || got.text !== block.text) return false
    const keys = Object.keys(got)
    return keys.length === 2 && keys.includes('type') && keys.includes('text')
  })
}

function pageSlice(binding, byteStart, byteEnd) {
  const length = byteEnd - byteStart
  if (!Number.isSafeInteger(length) || length < 0) return undefined
  try {
    const page = readArtifactPage(binding.artifact, byteStart, Math.max(4, length))
    return page.nextOffset === byteEnd ? page.bytes : undefined
  } catch {
    return undefined
  }
}

/**
 * Create the bound input service. The policy seam is optional for focused page
 * tests; production installation always supplies it so completion feeds the
 * guard. When supplied, the binding must already exist in the policy and the
 * reviewer must still be awaiting its plan input.
 * @param options - optional { policy } review-policy seam.
 * @returns the tool definition plus the binding, observation and coverage surface.
 */
export function createReviewInput(options = {}) {
  if (options === null || typeof options !== 'object') fail('REVIEW_INPUT_INVALID_POLICY', 'Expected an options object')
  const policy = options.policy
  if (policy !== undefined) {
    if (
      policy === null ||
      typeof policy !== 'object' ||
      typeof policy.recordDelivery !== 'function' ||
      typeof policy.stageOf !== 'function' ||
      typeof policy.state !== 'function'
    ) {
      fail('REVIEW_INPUT_INVALID_POLICY', 'The policy seam must expose recordDelivery, stageOf and state')
    }
  }

  const bindings = new Map()
  const issued = new Map()
  let closed = false

  function coverageOf(childId) {
    const binding = bindings.get(childId)
    if (binding === undefined) return undefined
    return Object.freeze({
      childId: binding.childId,
      lane: binding.lane,
      workspace: binding.workspace,
      relativePath: binding.relativePath,
      sha256: binding.sha256,
      instructionSha256: binding.instructionSha256,
      totalBytes: binding.totalBytes,
      deliveredBytes: binding.deliveredBytes,
      pages: binding.pages,
      complete: binding.complete,
    })
  }

  function incomplete(binding, reason, detail) {
    return Object.freeze({
      ok: false,
      status: REVIEW_INPUT_INCOMPLETE,
      reason,
      detail: String(detail),
      childId: binding?.childId,
      lane: binding?.lane,
      sha256: binding?.sha256,
      instructionSha256: binding?.instructionSha256,
      deliveredBytes: binding?.deliveredBytes ?? 0,
      totalBytes: binding?.totalBytes ?? 0,
      pages: binding?.pages ?? 0,
      complete: binding?.complete === true,
    })
  }

  function delivered(binding, value, advanced, replay) {
    return Object.freeze({
      ok: true,
      status: REVIEW_INPUT_DELIVERED,
      advanced,
      replay,
      childId: binding.childId,
      lane: binding.lane,
      sha256: binding.sha256,
      instructionSha256: binding.instructionSha256,
      byteStart: value.byteStart,
      byteEnd: value.byteEnd,
      deliveredBytes: binding.deliveredBytes,
      totalBytes: binding.totalBytes,
      pages: binding.pages,
      pageDone: value.done === true,
      complete: binding.complete,
    })
  }

  /**
   * Bind one captured immutable snapshot to one pre-bound reviewer child.
   * The Host, never the model, supplies this assignment.
   */
  function bindReviewInput(input) {
    if (closed) fail('REVIEW_INPUT_CLOSED', 'Review input admission is closed')
    if (!isPlainObject(input)) fail('REVIEW_INPUT_INVALID_BINDING', 'Expected one reviewer input binding object')
    const { childId, lane, artifact } = input
    if (typeof childId !== 'string' || childId.length === 0 || /[\u0000-\u001f\u007f]/.test(childId)) {
      fail('REVIEW_INPUT_INVALID_BINDING', 'Expected one nonempty pre-bound child session id')
    }
    if (childId === '__proto__' || childId === 'prototype' || childId === 'constructor') {
      fail('REVIEW_INPUT_INVALID_BINDING', 'Reserved object keys are not reviewer session ids')
    }
    if (!REVIEW_LANES.includes(lane)) fail('REVIEW_INPUT_INVALID_BINDING', 'Unknown review lane: ' + String(lane))
    if (bindings.has(childId)) {
      fail('REVIEW_INPUT_ALREADY_BOUND', 'Reviewer ' + childId + ' already has bound plan input; a new round needs a new pre-bound child id')
    }
    if (policy !== undefined) {
      const assignments = policy.state()
      const assignment = Object.hasOwn(assignments, childId) ? assignments[childId] : undefined
      if (assignment === undefined) fail('REVIEW_INPUT_UNASSIGNED', 'No pre-bound reviewer assignment exists for ' + childId)
      if (assignment.lane !== lane) fail('REVIEW_INPUT_LANE_MISMATCH', 'The bound lane does not match the pre-bound assignment lane')
      if (assignment.settled === true || assignment.stage === REVIEW_STAGES.settled) fail('REVIEW_INPUT_SETTLED', 'Reviewer ' + childId + ' has settled; plan input cannot be bound')
      if (assignment.stage !== REVIEW_STAGES.awaitingInput) fail('REVIEW_INPUT_INVALID_ASSIGNMENT', 'Plan input must be bound before delivery starts')
    }
    if (artifact === null || typeof artifact !== 'object') fail('REVIEW_INPUT_INVALID_ARTIFACT', 'Expected one captured immutable review artifact')
    try {
      readArtifactPage(artifact, 0, 4)
    } catch (error) {
      if (error instanceof ReviewArtifactError) fail('REVIEW_INPUT_INVALID_ARTIFACT', 'Expected one captured immutable review artifact')
      throw error
    }
    const totalBytes = artifact.totalBytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) fail('REVIEW_INPUT_EMPTY_ARTIFACT', 'The bound snapshot has no plan bytes')
    const source = artifact.source ?? {}
    if (
      typeof artifact.sha256 !== 'string' ||
      typeof artifact.instructionSha256 !== 'string' ||
      typeof source.workspace !== 'string' ||
      typeof source.relativePath !== 'string'
    ) {
      fail('REVIEW_INPUT_INVALID_ARTIFACT', 'The captured artifact exposes no raw source metadata')
    }
    bindings.set(childId, {
      childId,
      lane,
      artifact,
      workspace: source.workspace,
      relativePath: source.relativePath,
      sha256: artifact.sha256,
      instructionSha256: artifact.instructionSha256,
      totalBytes,
      deliveredBytes: 0,
      pages: 0,
      complete: false,
    })
    return coverageOf(childId)
  }

  /** Serve one page to the exec.agent's bound assignment; never to a named path. */
  function readPage(args, exec) {
    if (closed) fail('REVIEW_INPUT_CLOSED', 'Review input admission is closed')
    const cursor = parseCursor(args)
    const childId = sessionIdOf(exec?.agent)
    const binding = childId === undefined ? undefined : bindings.get(childId)
    if (binding === undefined) fail('REVIEW_INPUT_UNBOUND', 'Only a pre-bound reviewer session may request plan bytes')
    if (policy !== undefined) {
      const stage = policy.stageOf(childId)
      if (stage !== REVIEW_STAGES.awaitingInput && stage !== REVIEW_STAGES.inputComplete) {
        fail('REVIEW_INPUT_STALE_ASSIGNMENT', 'Reviewer ' + childId + ' is not accepting plan input in its current phase')
      }
    }
    if (typeof exec.callId !== 'string' || exec.callId.length === 0) fail('REVIEW_INPUT_INVALID_EXECUTION', 'Expected one Host-issued tool call identity')
    if (issued.has(exec.callId)) fail('REVIEW_INPUT_DUPLICATE_CALL', 'This tool call identity already issued a page')
    let page
    try {
      page = readArtifactPage(binding.artifact, cursor)
    } catch (error) {
      if (error instanceof ReviewArtifactError) fail('REVIEW_INPUT_PAGE_INVALID', error.message)
      throw error
    }
    if (page.totalBytes !== binding.totalBytes) fail('REVIEW_INPUT_INVALID_ARTIFACT', 'The bound snapshot changed size')
    const value = Object.freeze({
      source: Object.freeze({
        workspace: binding.workspace,
        relativePath: binding.relativePath,
        sha256: binding.sha256,
        instructionSha256: binding.instructionSha256,
      }),
      lane: binding.lane,
      byteStart: page.offset,
      byteEnd: page.nextOffset,
      nextCursor: page.nextOffset,
      totalBytes: page.totalBytes,
      text: page.text,
      done: page.done,
    })
    issued.set(exec.callId, Object.freeze({
      childId,
      lane: binding.lane,
      value,
      content: Object.freeze(renderPage(value)),
    }))
    return value
  }

  /**
   * Observe one authoritative final tools/result. This is the ONLY coverage
   * credit path; it returns an observation describing what happened.
   */
  function observeResult(exec, result) {
    if (!isPlainObject(exec) || exec.name !== REVIEW_INPUT_TOOL) return undefined
    const callId = exec.callId
    const record = typeof callId === 'string' ? issued.get(callId) : undefined
    if (record === undefined) {
      return incomplete(bindings.get(sessionIdOf(exec.agent)), REVIEW_INPUT_REASONS.unknownCall, 'No page issuance matches this final result')
    }
    issued.delete(callId)
    const binding = bindings.get(record.childId)
    if (binding === undefined) return incomplete(undefined, REVIEW_INPUT_REASONS.unbound, 'The issuing assignment no longer exists')
    const observedBy = sessionIdOf(exec.agent)
    if (observedBy !== record.childId) {
      return incomplete(binding, REVIEW_INPUT_REASONS.crossLane, 'A final result is credited only to the session that requested the page')
    }
    if (result === null || typeof result !== 'object' || result.isError !== false) {
      return incomplete(binding, REVIEW_INPUT_REASONS.resultFailed, 'The final tool result did not succeed; no page bytes count')
    }
    if (!samePageValue(record.value, result.value)) {
      return incomplete(binding, REVIEW_INPUT_REASONS.canonicalReplaced, 'The final canonical value no longer matches the issued page')
    }
    const envelope = visibleEnvelope(result.content)
    if (envelope === undefined || typeof envelope.text !== 'string') {
      return incomplete(binding, REVIEW_INPUT_REASONS.visibleTextMissing, 'The final content carries no parseable page text')
    }
    const slice = pageSlice(binding, record.value.byteStart, record.value.byteEnd)
    if (slice === undefined || Buffer.compare(Buffer.from(envelope.text, 'utf8'), slice) !== 0) {
      return incomplete(binding, REVIEW_INPUT_REASONS.textMismatch, 'The model-visible page text does not equal the snapshot byte range')
    }
    if (!sameContent(record.content, result.content)) {
      return incomplete(binding, REVIEW_INPUT_REASONS.contentReplaced, 'The final content is not the unmodified page projection; a replacement never counts')
    }
    if (record.value.byteStart > binding.deliveredBytes) {
      return incomplete(binding, REVIEW_INPUT_REASONS.gap, 'The page starts beyond the contiguous delivered offset; the gap keeps coverage unchanged')
    }
    if (record.value.byteStart < binding.deliveredBytes || record.value.byteEnd === binding.deliveredBytes) {
      return delivered(binding, record.value, false, true)
    }
    const deliveredBytes = record.value.byteEnd
    const pages = binding.pages + 1
    if (deliveredBytes < binding.deliveredBytes || deliveredBytes > binding.totalBytes) {
      return incomplete(binding, REVIEW_INPUT_REASONS.gap, 'The page does not extend contiguous coverage')
    }
    if (policy !== undefined) {
      try {
        policy.recordDelivery(binding.childId, { deliveredBytes, totalBytes: binding.totalBytes })
      } catch (error) {
        return incomplete(binding, REVIEW_INPUT_REASONS.policyRefused, error instanceof Error ? error.message : String(error))
      }
    }
    binding.deliveredBytes = deliveredBytes
    binding.pages = pages
    binding.complete = deliveredBytes === binding.totalBytes
    return delivered(binding, record.value, true, false)
  }

  function isComplete(childId) {
    return bindings.get(childId)?.complete === true
  }

  function state() {
    const snapshot = {}
    for (const childId of bindings.keys()) snapshot[childId] = coverageOf(childId)
    return Object.freeze(snapshot)
  }

  function closeAdmission() {
    closed = true
  }

  const definition = Object.freeze({
    name: REVIEW_INPUT_TOOL,
    description:
      'Deliver the next byte page of the immutable plan snapshot bound to this reviewer session. ' +
      'The only model parameter is a UTF-8 byte cursor; path, lane, session and coverage are Host-owned. ' +
      'A page is credited only after the final tools/result carries the exact snapshot bytes, so never treat a partial, summarized or spilled result as coverage.',
    parameters: REVIEW_INPUT_PARAMETERS,
    output: Object.freeze({
      schema: REVIEW_INPUT_OUTPUT_SCHEMA,
      render: (args, value) => renderPage(value),
    }),
    execute: readPage,
  })

  return Object.freeze({
    definition,
    bindReviewInput,
    observeResult,
    coverageOf,
    isComplete,
    state,
    closeAdmission,
  })
}

/**
 * Register the input tool and its final-result observer on the Host.
 * Disposal removes both; a partial registration is never left behind.
 * @param options - { tools, policy, onResult }.
 * @returns the service surface plus an idempotent dispose().
 */
export function installReviewInput(options = {}) {
  const tools = options?.tools
  if (tools === null || typeof tools !== 'object' || typeof tools.register !== 'function') {
    fail('REVIEW_INPUT_TOOLS_UNAVAILABLE', 'installReviewInput needs the Host tools registry (tools.register)')
  }
  if (typeof options.onResult !== 'function') {
    fail('REVIEW_INPUT_RESULT_HOOK_REQUIRED', 'installReviewInput needs a tools/result subscription; coverage is credited only after the final result')
  }
  if (options.policy === null || typeof options.policy !== 'object' || typeof options.policy.recordDelivery !== 'function') {
    fail('REVIEW_INPUT_POLICY_UNAVAILABLE', 'installReviewInput needs the review-policy seam')
  }
  const service = createReviewInput({ policy: options.policy })
  const removeTool = tools.register(service.definition)
  if (typeof removeTool !== 'function') fail('REVIEW_INPUT_DISPOSER_MISSING', 'tools.register did not return a disposer')
  let removeResult
  try {
    removeResult = options.onResult(service.observeResult)
  } catch (error) {
    try {
      removeTool()
    } catch {
      // The original hook failure owns the report.
    }
    fail('REVIEW_INPUT_RESULT_HOOK_UNAVAILABLE', 'The tools/result subscription failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (typeof removeResult !== 'function') {
    try {
      removeTool()
    } catch {
      // The missing disposer owns the report.
    }
    fail('REVIEW_INPUT_RESULT_HOOK_UNAVAILABLE', 'The tools/result subscription returned no disposer')
  }
  let disposal
  function dispose() {
    if (disposal !== undefined) return disposal
    disposal = (async () => {
      service.closeAdmission()
      let firstError
      try {
        removeTool()
      } catch (error) {
        firstError ??= error
      }
      try {
        removeResult()
      } catch (error) {
        firstError ??= error
      }
      if (firstError !== undefined) throw firstError
    })()
    return disposal
  }
  return Object.freeze({ ...service, dispose })
}
