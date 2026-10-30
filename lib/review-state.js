/** Pure, synchronous, zero-IO review state machine for Scope interfaces 6-9.
 *
 * This module owns one plan's atomic record: required-only requirements, a single
 * active round, launch/child/run/lane receipts, immutable input coverage, the
 * accepted blocker ledger, bounded convergence and the explicit approval
 * predicate. It never reads files, timers, clocks, randomness, process state or
 * assistant prose: callers inject hashes, identities, coverage and sequence-free
 * round identities. A receipt is only ever built from a protocol-validated
 * structured result plus runtime identity/coverage data.
 */
import { createHash } from 'node:crypto'
import { parseReviewConfig } from './review-config.js'
import {
  BLOCKER_ELIGIBILITIES,
  REVIEW_LANES,
  REVIEW_STATES,
  ReviewContractError,
  assertPlainJson,
  assertReviewKeys,
  parseHandoffRequest,
  validateReviewResult,
} from './review-protocol.js'

export const REVIEW_RECORD_VERSION = 1
export const REVIEW_ROUND_STATES = Object.freeze(['in_flight', 'changes_requested', 'approved', 'inconclusive', 'stale', 'cancelled', 'stopped'])
export const REVIEW_LANE_STATUSES = Object.freeze(['in_flight', 'completed', 'inconclusive', 'failed', 'cancelled', 'stale'])
export const REVIEW_LEDGER_STATUSES = Object.freeze(['open', 'closed'])
export const REVIEW_LANE_FAILURES = Object.freeze(['max_tokens', 'timeout', 'error', 'refused', 'interrupted'])
export const REVIEW_OUTCOMES = Object.freeze([
  'required', 'required_already', 'started', 'existing_round', 'start_rejected',
  'run_bound', 'run_already_bound', 'run_rejected',
  'result_accepted', 'approved', 'changes_requested', 'inconclusive', 'stopped', 'stopped_budget',
  'result_duplicate', 'result_rejected', 'lane_failed', 'lane_failure_rejected',
  'cancelled', 'cancel_rejected', 'source_updated', 'source_tick', 'stale', 'policy_updated',
  'noop', 'invalid_record', 'invalid_event', 'invalid_transition',
])

const RECORD_KEYS = ['version', 'target', 'workspace', 'required', 'state', 'revision', 'source', 'policy', 'budget', 'activeRoundId', 'approvedRoundId', 'rounds', 'ledger']
const SOURCE_KEYS = ['planSha256', 'instructionSha256']
const POLICY_KEYS = ['scopeSha256', 'configSha256', 'roleSha256', 'policySha256']
const BUDGET_KEYS = ['authorized', 'consumed', 'exhausted']
const ROUND_KEYS = ['roundId', 'launchId', 'number', 'state', 'source', 'policy', 'lanes', 'blockersAdded', 'blockersClosed']
const LANE_KEYS = ['childId', 'runId', 'status', 'result', 'receipt', 'reason']
const RECEIPT_KEYS = ['lane', 'roundId', 'launchId', 'childId', 'runId', 'planSha256', 'instructionSha256', 'policy', 'coverage', 'verdict', 'stopReason', 'resultSha256']
const COVERAGE_KEYS = ['complete', 'pages', 'deliveredBytes', 'totalBytes', 'planSha256', 'instructionSha256']
const LEDGER_KEYS = ['id', 'fingerprint', 'eligibility', 'location', 'evidence', 'remediation', 'status', 'roundId', 'firstSeenRound']
const LOCATION_KEYS = ['taskId', 'isId', 'gapId']
const EVIDENCE_KEYS = ['path', 'line', 'endLine']
const FAIL = (code, path, message) => { throw new ReviewContractError(code, path, message) }
const DIGEST = /^[a-f0-9]{64}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const LOCATION_PATTERNS = Object.freeze({ taskId: /^(?:[1-9][0-9]*|F[1-9][0-9]*)?$/, isId: /^(?:IS-[1-9][0-9]*)?$/, gapId: /^(?:GAP-[1-9][0-9]*)?$/ })
const isDigest = value => typeof value === 'string' && DIGEST.test(value)
const isIdentifier = value => typeof value === 'string' && ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && IDENTIFIER.test(value)
const controlled = value => typeof value !== 'string' || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const hashJson = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
const snapshot = value => deepFreeze(clone(value))
const diagnostic = (code, path, message) => ({ code, path, message })
const toDiagnostic = error => error instanceof ReviewContractError
  ? diagnostic(error.code, error.path ?? '$', error.message)
  : diagnostic('INVALID_REQUEST', '$', 'Invalid review event')

const assertDigest = (value, path, code = 'INVALID_REQUEST') => {
  if (!isDigest(value)) FAIL(code, path, 'Expected raw SHA-256 hex')
  return value
}
const assertId = (value, path, code = 'INVALID_REQUEST') => {
  if (!isIdentifier(value)) FAIL(code, path, 'Expected a canonical identifier')
  return value
}
const assertText = (value, path, code = 'INVALID_REQUEST') => {
  if (typeof value !== 'string' || !value.trim() || controlled(value)) FAIL(code, path, 'Expected nonempty text')
  return value
}
const samePolicy = (a, b) => Boolean(a && b) && POLICY_KEYS.every(key => a[key] === b[key])
const safePolicyHash = policy => POLICY_KEYS.every(key => isDigest(policy?.[key]))
  ? hashJson({ version: 1, scopeSha256: policy.scopeSha256, configSha256: policy.configSha256, roleSha256: policy.roleSha256 })
  : null
const resultSha256 = result => hashJson(result)
const safeResultHash = result => {
  try { return resultSha256(result) } catch { return null }
}

/** Semantic config identity: routes and effort only. Budget, enabled and backend
 * are operational gates and deliberately never enter the policy hash (F6).
 */
export function reviewConfigHash(rawConfig) {
  const parsed = parseReviewConfig(rawConfig)
  const lanes = REVIEW_LANES.map(lane => {
    const route = parsed.lanes[lane]
    return [lane, route === undefined ? null : {
      provider: route.provider,
      model: route.model,
      maxTokens: route.maxTokens,
      reasoningEffort: route.reasoningEffort ?? null,
    }]
  })
  return hashJson({ version: 1, lanes })
}

export function reviewPolicyHash({ scopeSha256, configSha256, roleSha256 }) {
  assertDigest(scopeSha256, '$.scopeSha256')
  assertDigest(configSha256, '$.configSha256')
  assertDigest(roleSha256, '$.roleSha256')
  return hashJson({ version: 1, scopeSha256, configSha256, roleSha256 })
}

export function reviewPolicyComponents(input) {
  assertPlainJson(input, 'INVALID_REQUEST')
  assertReviewKeys(input, ['scopeSha256', 'roleSha256', 'config'], ['scopeSha256', 'roleSha256', 'config'], 'INVALID_REQUEST')
  const scopeSha256 = assertDigest(input.scopeSha256, '$.scopeSha256')
  const roleSha256 = assertDigest(input.roleSha256, '$.roleSha256')
  const configSha256 = reviewConfigHash(input.config)
  return deepFreeze({ scopeSha256, configSha256, roleSha256, policySha256: reviewPolicyHash({ scopeSha256, configSha256, roleSha256 }) })
}

function normalizePolicy(raw) {
  assertPlainJson(raw, 'INVALID_REQUEST')
  assertReviewKeys(raw, POLICY_KEYS, ['scopeSha256', 'configSha256', 'roleSha256'], 'INVALID_REQUEST', '$.policy')
  const scopeSha256 = assertDigest(raw.scopeSha256, '$.policy.scopeSha256')
  const configSha256 = assertDigest(raw.configSha256, '$.policy.configSha256')
  const roleSha256 = assertDigest(raw.roleSha256, '$.policy.roleSha256')
  const policySha256 = reviewPolicyHash({ scopeSha256, configSha256, roleSha256 })
  if (Object.hasOwn(raw, 'policySha256') && raw.policySha256 !== policySha256) {
    FAIL('STALE_ARTIFACT', '$.policy.policySha256', 'Policy hash does not match its semantic components')
  }
  return { scopeSha256, configSha256, roleSha256, policySha256 }
}

function normalizeSource(raw) {
  assertPlainJson(raw, 'INVALID_REQUEST')
  assertReviewKeys(raw, SOURCE_KEYS, SOURCE_KEYS, 'INVALID_REQUEST', '$.source')
  return {
    planSha256: assertDigest(raw.planSha256, '$.source.planSha256'),
    instructionSha256: assertDigest(raw.instructionSha256, '$.source.instructionSha256'),
  }
}

/** Blocker identity survives prose rewording and line drift: the stable ID,
 * remediation text and summary are not identity. A legitimate new finding needs
 * a different eligibility, plan location or evidence path.
 */
export function blockerFingerprint(blocker) {
  if (!blocker || typeof blocker !== 'object' || !Array.isArray(blocker.evidence)) FAIL('INVALID_REQUEST', '$.blocker', 'Expected a blocker with evidence')
  const paths = [...new Set(blocker.evidence.map(entry => entry?.path))].sort()
  return hashJson({
    version: 1,
    eligibility: blocker.eligibility,
    location: [blocker.location?.taskId, blocker.location?.isId, blocker.location?.gapId],
    evidencePaths: paths,
  })
}

/** Explicit conjunction behind approved. Every missing condition is reported. */
function approvalReasons(record) {
  const reasons = []
  if (!record || typeof record !== 'object' || record.version !== REVIEW_RECORD_VERSION) return ['INVALID_RECORD']
  if (record.required !== true) reasons.push('NOT_REQUIRED')
  if (record.state !== 'approved') reasons.push('STATE_NOT_APPROVED')
  if (record.activeRoundId !== null) reasons.push('ACTIVE_ROUND_PRESENT')
  if (!Array.isArray(record.rounds) || record.rounds.length === 0) return reasons.concat('NO_ROUND')
  if (record.rounds.some(round => round && round.state === 'in_flight')) reasons.push('LIVE_ROUND_PRESENT')
  const approvedRounds = record.rounds.filter(round => round && round.state === 'approved')
  if (approvedRounds.length !== 1) reasons.push('APPROVED_ROUND_COUNT')
  const round = approvedRounds[0]
  if (!round || record.approvedRoundId === null || record.approvedRoundId !== round.roundId) reasons.push('APPROVED_ROUND_MISMATCH')
  if (!round) return reasons

  const source = record.source
  if (!source || !isDigest(source.planSha256) || !isDigest(source.instructionSha256)) reasons.push('SOURCE_MISSING')
  if (source && isDigest(source.instructionSha256) && (!round.source || source.instructionSha256 !== round.source.instructionSha256)) reasons.push('INSTRUCTION_DRIFT')
  if (!round.source || !isDigest(round.source.planSha256) || !isDigest(round.source.instructionSha256)) reasons.push('SOURCE_MISSING')

  if (!round.policy || !POLICY_KEYS.every(key => isDigest(round.policy[key]))) reasons.push('POLICY_MISMATCH')
  else if (safePolicyHash(round.policy) !== round.policy.policySha256) reasons.push('POLICY_HASH_MISMATCH')
  if (!record.policy || !POLICY_KEYS.every(key => isDigest(record.policy[key]))) reasons.push('POLICY_MISMATCH')
  else {
    if (safePolicyHash(record.policy) !== record.policy.policySha256) reasons.push('POLICY_HASH_MISMATCH')
    if (!samePolicy(record.policy, round.policy)) reasons.push('POLICY_MISMATCH')
  }

  const budget = record.budget
  const budgetShape = budget
    && Number.isSafeInteger(budget.authorized) && budget.authorized >= 0 && budget.authorized % 2 === 0
    && Number.isSafeInteger(budget.consumed) && budget.consumed >= 0 && budget.consumed % 2 === 0
    && budget.consumed <= budget.authorized
    && budget.consumed === record.rounds.length * 2
  if (!budgetShape) reasons.push('BUDGET_INVALID')
  else if (budget.exhausted !== false) reasons.push('BUDGET_EXHAUSTED')

  if (!Array.isArray(record.ledger)) reasons.push('LEDGER_INVALID')
  else if (record.ledger.some(entry => !entry || entry.status !== 'closed')) reasons.push('LEDGER_OPEN')

  const lanes = round.lanes
  if (!lanes || typeof lanes !== 'object') {
    reasons.push('LANE_NOT_TERMINAL')
    return reasons
  }
  for (const laneName of REVIEW_LANES) {
    const lane = lanes[laneName]
    if (!lane || lane.status !== 'completed') {
      reasons.push('LANE_NOT_TERMINAL')
      continue
    }
    const receipt = lane.receipt
    if (!receipt) {
      reasons.push('MISSING_RECEIPT')
      continue
    }
    const result = lane.result
    if (!result || result.verdict !== 'OKAY' || receipt.verdict !== 'OKAY') reasons.push('VERDICT_NOT_OKAY')
    if (!result || !Array.isArray(result.blockers) || result.blockers.length > 0) reasons.push('BLOCKERS_PRESENT')
    if (receipt.lane !== laneName || receipt.roundId !== round.roundId || receipt.launchId !== round.launchId || receipt.childId !== lane.childId || receipt.runId !== lane.runId) reasons.push('RECEIPT_BINDING_MISMATCH')
    if (receipt.planSha256 !== round.source.planSha256 || receipt.instructionSha256 !== round.source.instructionSha256) reasons.push('RECEIPT_BINDING_MISMATCH')
    if (!receipt.policy || !samePolicy(receipt.policy, round.policy)) reasons.push('RECEIPT_BINDING_MISMATCH')
    const coverage = receipt.coverage
    if (!coverage || coverage.complete !== true || coverage.planSha256 !== round.source.planSha256 || coverage.instructionSha256 !== round.source.instructionSha256 || !(Number.isSafeInteger(coverage.pages) && coverage.pages >= 1) || !(Number.isSafeInteger(coverage.totalBytes) && coverage.totalBytes > 0) || coverage.deliveredBytes !== coverage.totalBytes || !Number.isSafeInteger(coverage.deliveredBytes) || coverage.deliveredBytes < 0) reasons.push('COVERAGE_INCOMPLETE')
    if (!result || receipt.resultSha256 !== safeResultHash(result)) reasons.push('RESULT_HASH_MISMATCH')
    if (receipt.stopReason !== 'completed') reasons.push('RECEIPT_BINDING_MISMATCH')
  }
  return reasons
}

export function evaluateApproval(record) {
  let reasons
  try { reasons = approvalReasons(record) } catch { reasons = ['INVALID_RECORD'] }
  const approved = reasons.length === 0
  const round = approved ? record.rounds.find(entry => entry.roundId === record.approvedRoundId) : null
  return {
    approved,
    reasons,
    roundId: approved ? round.roundId : null,
    receipts: approved ? { practical: round.lanes.practical.receipt, adversarial: round.lanes.adversarial.receipt } : null,
  }
}

function checkEvidence(evidence, path) {
  if (!Array.isArray(evidence)) FAIL('INVALID_REQUEST', path, 'Expected an evidence array')
  evidence.forEach((entry, index) => {
    assertReviewKeys(entry, EVIDENCE_KEYS, EVIDENCE_KEYS, 'INVALID_REQUEST', path + '.' + index)
    assertText(entry.path, path + '.' + index + '.path')
    if (!Number.isSafeInteger(entry.line) || entry.line < 1 || !Number.isSafeInteger(entry.endLine) || entry.endLine < entry.line) FAIL('INVALID_REQUEST', path + '.' + index, 'Invalid evidence coordinates')
  })
}

function checkLedgerEntry(entry, path) {
  assertReviewKeys(entry, LEDGER_KEYS, LEDGER_KEYS, 'INVALID_REQUEST', path)
  assertId(entry.id, path + '.id')
  assertDigest(entry.fingerprint, path + '.fingerprint')
  if (!BLOCKER_ELIGIBILITIES.includes(entry.eligibility)) FAIL('INVALID_REQUEST', path + '.eligibility', 'Ineligible ledger blocker')
  assertReviewKeys(entry.location, LOCATION_KEYS, LOCATION_KEYS, 'INVALID_REQUEST', path + '.location')
  for (const key of LOCATION_KEYS) {
    const value = entry.location[key]
    if (controlled(value) || !LOCATION_PATTERNS[key].test(value)) FAIL('INVALID_REQUEST', path + '.location.' + key, 'Invalid plan location')
  }
  checkEvidence(entry.evidence, path + '.evidence')
  if (entry.evidence.length === 0) FAIL('INVALID_REQUEST', path + '.evidence', 'Eligible blockers need evidence')
  assertText(entry.remediation, path + '.remediation')
  if (!REVIEW_LEDGER_STATUSES.includes(entry.status)) FAIL('INVALID_REQUEST', path + '.status', 'Unknown ledger status')
  assertId(entry.roundId, path + '.roundId')
  if (!Number.isSafeInteger(entry.firstSeenRound) || entry.firstSeenRound < 1) FAIL('INVALID_REQUEST', path + '.firstSeenRound', 'Expected a positive round number')
  if (blockerFingerprint(entry) !== entry.fingerprint) FAIL('INVALID_REQUEST', path + '.fingerprint', 'Fingerprint does not match blocker identity')
}

function checkCoverageShape(coverage, path) {
  assertReviewKeys(coverage, COVERAGE_KEYS, COVERAGE_KEYS, 'INVALID_REQUEST', path)
  if (typeof coverage.complete !== 'boolean') FAIL('INVALID_REQUEST', path + '.complete', 'Expected boolean')
  for (const key of ['pages', 'deliveredBytes', 'totalBytes']) {
    if (!Number.isSafeInteger(coverage[key]) || coverage[key] < 0) FAIL('INVALID_REQUEST', path + '.' + key, 'Expected a nonnegative integer')
  }
  assertDigest(coverage.planSha256, path + '.planSha256')
  assertDigest(coverage.instructionSha256, path + '.instructionSha256')
}

function checkReceipt(receipt, laneName, round, lane, path) {
  assertReviewKeys(receipt, RECEIPT_KEYS, RECEIPT_KEYS, 'INVALID_REQUEST', path)
  assertId(receipt.lane, path + '.lane')
  assertId(receipt.roundId, path + '.roundId')
  assertId(receipt.launchId, path + '.launchId')
  assertId(receipt.childId, path + '.childId')
  assertId(receipt.runId, path + '.runId')
  assertDigest(receipt.planSha256, path + '.planSha256')
  assertDigest(receipt.instructionSha256, path + '.instructionSha256')
  assertDigest(receipt.resultSha256, path + '.resultSha256')
  const policy = normalizePolicy(receipt.policy)
  if (receipt.lane !== laneName || receipt.roundId !== round.roundId || receipt.launchId !== round.launchId || receipt.childId !== lane.childId || receipt.runId !== lane.runId) FAIL('INVALID_REQUEST', path, 'Receipt identity does not match its lane')
  if (receipt.planSha256 !== round.source.planSha256 || receipt.instructionSha256 !== round.source.instructionSha256) FAIL('INVALID_REQUEST', path, 'Receipt source does not match its round')
  if (!samePolicy(policy, round.policy)) FAIL('INVALID_REQUEST', path + '.policy', 'Receipt policy does not match its round')
  checkCoverageShape(receipt.coverage, path + '.coverage')
  const coverage = receipt.coverage
  if (coverage.complete !== true || coverage.pages < 1 || coverage.totalBytes <= 0 || coverage.deliveredBytes !== coverage.totalBytes) FAIL('INVALID_REQUEST', path + '.coverage', 'Receipts require complete bounded input coverage')
  if (coverage.planSha256 !== round.source.planSha256 || coverage.instructionSha256 !== round.source.instructionSha256) FAIL('INVALID_REQUEST', path + '.coverage', 'Coverage does not bind the reviewed source')
  if (!['OKAY', 'REJECT', 'INCONCLUSIVE'].includes(receipt.verdict)) FAIL('INVALID_REQUEST', path + '.verdict', 'Unknown verdict')
  if (receipt.stopReason !== 'completed') FAIL('INVALID_REQUEST', path + '.stopReason', 'Receipts require a completed stop reason')
  if (!lane.result || lane.result.verdict !== receipt.verdict) FAIL('INVALID_REQUEST', path + '.verdict', 'Receipt verdict does not match its result')
  if (receipt.resultSha256 !== resultSha256(lane.result)) FAIL('INVALID_REQUEST', path + '.resultSha256', 'Receipt does not bind the exact structured result')
}

function checkLane(lane, laneName, round, activeRoundId, path) {
  assertReviewKeys(lane, LANE_KEYS, LANE_KEYS, 'INVALID_REQUEST', path)
  assertId(lane.childId, path + '.childId')
  if (lane.runId !== null) assertId(lane.runId, path + '.runId')
  if (!REVIEW_LANE_STATUSES.includes(lane.status)) FAIL('INVALID_REQUEST', path + '.status', 'Unknown lane status')
  const terminal = lane.status !== 'in_flight'
  if (terminal && lane.runId === null) FAIL('INVALID_REQUEST', path + '.runId', 'Terminal lanes require a bound run identity')
  if (lane.status === 'completed') {
    if (!lane.result) FAIL('INVALID_REQUEST', path + '.result', 'Completed lanes require a structured result')
    const checked = validateReviewResult(lane.result, { lane: laneName, roundId: round.roundId, launchId: round.launchId, planSha256: round.source.planSha256 })
    if (!checked.ok) FAIL('INVALID_REQUEST', path + '.result', 'Stored result is not protocol-valid: ' + checked.diagnostics[0].code)
    if (!lane.receipt) FAIL('INVALID_REQUEST', path + '.receipt', 'Completed lanes require a receipt')
    checkReceipt(lane.receipt, laneName, round, lane, path + '.receipt')
    if (lane.reason !== null) FAIL('INVALID_REQUEST', path + '.reason', 'Completed lanes have no failure reason')
  } else if (lane.status === 'in_flight') {
    if (lane.result !== null || lane.receipt !== null || lane.reason !== null) FAIL('INVALID_REQUEST', path, 'An in-flight lane cannot carry a result, receipt or reason')
  } else if (lane.status === 'inconclusive') {
    if (lane.result !== null || lane.receipt !== null) FAIL('INVALID_REQUEST', path, 'Inconclusive lanes carry no receipt')
    if (!['INVALID_RESULT', 'STALE_ARTIFACT', 'COVERAGE_INCOMPLETE'].includes(lane.reason)) FAIL('INVALID_REQUEST', path + '.reason', 'Unknown inconclusive reason')
  } else if (lane.status === 'failed') {
    if (lane.result !== null || lane.receipt !== null) FAIL('INVALID_REQUEST', path, 'Failed lanes carry no receipt')
    if (!REVIEW_LANE_FAILURES.includes(lane.reason)) FAIL('INVALID_REQUEST', path + '.reason', 'Unknown lane failure reason')
  } else if (lane.status === 'cancelled') {
    if (lane.result !== null || lane.receipt !== null || lane.reason !== 'cancelled') FAIL('INVALID_REQUEST', path, 'Cancelled lanes carry no receipt')
  } else if (lane.status === 'stale') {
    if (lane.result !== null || lane.receipt !== null || lane.reason !== 'stale') FAIL('INVALID_REQUEST', path, 'Stale lanes carry no receipt')
  }
  if (round.state === 'in_flight' && activeRoundId !== round.roundId) FAIL('INVALID_REQUEST', path, 'Only the active round may be in flight')
}

function checkRound(round, record, ledger, path) {
  assertReviewKeys(round, ROUND_KEYS, ROUND_KEYS, 'INVALID_REQUEST', path)
  const roundId = assertId(round.roundId, path + '.roundId')
  assertId(round.launchId, path + '.launchId')
  if (!Number.isSafeInteger(round.number) || round.number < 1) FAIL('INVALID_REQUEST', path + '.number', 'Expected a positive round number')
  if (!REVIEW_ROUND_STATES.includes(round.state)) FAIL('INVALID_REQUEST', path + '.state', 'Unknown round state')
  const source = normalizeSource(round.source)
  const policy = normalizePolicy(round.policy)
  for (const key of ['blockersAdded', 'blockersClosed']) {
    if (!Array.isArray(round[key])) FAIL('INVALID_REQUEST', path + '.' + key, 'Expected a fingerprint array')
    const seen = new Set()
    for (const fingerprint of round[key]) {
      assertDigest(fingerprint, path + '.' + key)
      if (seen.has(fingerprint)) FAIL('INVALID_REQUEST', path + '.' + key, 'Duplicate fingerprint')
      seen.add(fingerprint)
    }
  }
  for (const fingerprint of round.blockersAdded) {
    if (!ledger.some(entry => entry.fingerprint === fingerprint && entry.roundId === roundId)) FAIL('INVALID_REQUEST', path + '.blockersAdded', 'Added blocker is not in the ledger for this round')
  }
  for (const fingerprint of round.blockersClosed) {
    if (!ledger.some(entry => entry.fingerprint === fingerprint)) FAIL('INVALID_REQUEST', path + '.blockersClosed', 'Closed blocker is absent from historical ledger')
  }
  assertReviewKeys(round.lanes, REVIEW_LANES, REVIEW_LANES, 'INVALID_REQUEST', path + '.lanes')
  for (const laneName of REVIEW_LANES) checkLane(round.lanes[laneName], laneName, { ...round, source }, record.activeRoundId, path + '.lanes.' + laneName)
  const lanes = REVIEW_LANES.map(laneName => round.lanes[laneName])
  const terminal = lanes.every(lane => lane.status !== 'in_flight')
  if (round.state === 'in_flight') {
    if (record.activeRoundId !== roundId) FAIL('INVALID_REQUEST', path, 'In-flight round is not the active round')
    if (!lanes.some(lane => lane.status === 'in_flight')) FAIL('INVALID_REQUEST', path, 'In-flight round must have a live lane')
  } else {
    if (record.activeRoundId === roundId) FAIL('INVALID_REQUEST', path, 'A terminal round cannot be active')
    if (!terminal) FAIL('INVALID_REQUEST', path, 'A terminal round cannot have an in-flight lane')
  }
  const completed = lanes.every(lane => lane.status === 'completed')
  const verdicts = lanes.map(lane => lane.receipt?.verdict ?? null)
  if (round.state === 'approved') {
    if (!completed || verdicts.some(verdict => verdict !== 'OKAY')) FAIL('INVALID_REQUEST', path, 'Approved rounds need two completed OKAY lanes')
  } else if (round.state === 'changes_requested') {
    if (!completed || verdicts.includes('INCONCLUSIVE') || !verdicts.includes('REJECT')) FAIL('INVALID_REQUEST', path, 'changes_requested needs completed non-inconclusive REJECT evidence')
  } else if (round.state === 'inconclusive') {
    const hasInconclusiveLane = lanes.some(lane => lane.status !== 'completed')
    if (!hasInconclusiveLane && !verdicts.includes('INCONCLUSIVE')) FAIL('INVALID_REQUEST', path, 'Inconclusive rounds need an inconclusive lane or verdict')
  } else if (round.state === 'stopped') {
    if (!completed || !verdicts.includes('REJECT')) FAIL('INVALID_REQUEST', path, 'Stopped rounds retain completed REJECT evidence')
  } else if (round.state === 'cancelled') {
    if (!lanes.some(lane => lane.status === 'cancelled')) FAIL('INVALID_REQUEST', path, 'Cancelled rounds need a cancelled lane')
  }
  if (round.state === 'stale' && !terminal) FAIL('INVALID_REQUEST', path, 'Stale rounds are terminal')
  if (round.state === 'in_flight' || round.state === 'changes_requested' || round.state === 'approved' || round.state === 'inconclusive' || round.state === 'stopped') {
    if (!source || !isDigest(source.planSha256)) FAIL('INVALID_REQUEST', path + '.source', 'Rounds require a reviewed source')
  }
}

function checkRecord(raw) {
  assertPlainJson(raw, 'INVALID_REQUEST')
  assertReviewKeys(raw, RECORD_KEYS, RECORD_KEYS, 'INVALID_REQUEST')
  if (raw.version !== REVIEW_RECORD_VERSION) FAIL('INVALID_REQUEST', '$.version', 'Unsupported record version')
  parseHandoffRequest({ action: 'bind-worktree', target: raw.target, worktreePath: raw.workspace })
  if (!raw.target.startsWith('.dsh/ulw/plans/')) FAIL('INVALID_REQUEST', '$.target', 'Expected a workspace-relative canonical plan target')
  if (typeof raw.required !== 'boolean') FAIL('INVALID_REQUEST', '$.required', 'Expected boolean')
  if (!REVIEW_STATES.includes(raw.state)) FAIL('INVALID_REQUEST', '$.state', 'Unknown review state')
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) FAIL('INVALID_REQUEST', '$.revision', 'Expected a nonnegative revision')

  assertReviewKeys(raw.source, SOURCE_KEYS, SOURCE_KEYS, 'INVALID_REQUEST', '$.source')
  if (raw.source.planSha256 !== null) assertDigest(raw.source.planSha256, '$.source.planSha256')
  if (raw.source.instructionSha256 !== null) assertDigest(raw.source.instructionSha256, '$.source.instructionSha256')

  const policy = normalizePolicy(raw.policy)
  if (!samePolicy(policy, raw.policy)) FAIL('INVALID_REQUEST', '$.policy', 'Normalized policy differs')

  assertReviewKeys(raw.budget, BUDGET_KEYS, BUDGET_KEYS, 'INVALID_REQUEST', '$.budget')
  const { authorized, consumed, exhausted } = raw.budget
  if (!Number.isSafeInteger(authorized) || authorized < 0 || authorized % 2 !== 0) FAIL('BUDGET_EXHAUSTED', '$.budget.authorized', 'Expected a nonnegative even call budget')
  if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed % 2 !== 0 || consumed > authorized) FAIL('BUDGET_EXHAUSTED', '$.budget.consumed', 'Invalid consumed call budget')
  if (typeof exhausted !== 'boolean') FAIL('INVALID_REQUEST', '$.budget.exhausted', 'Expected boolean')

  if (raw.activeRoundId !== null) assertId(raw.activeRoundId, '$.activeRoundId')
  if (raw.approvedRoundId !== null) assertId(raw.approvedRoundId, '$.approvedRoundId')
  if (!Array.isArray(raw.rounds) || raw.rounds.length > 1000) FAIL('INVALID_REQUEST', '$.rounds', 'Expected a bounded rounds array')
  if (!Array.isArray(raw.ledger) || raw.ledger.length > 3000) FAIL('INVALID_REQUEST', '$.ledger', 'Expected a bounded ledger array')
  if (consumed !== raw.rounds.length * 2) FAIL('BUDGET_EXHAUSTED', '$.budget.consumed', 'Consumed budget must equal two calls per opened round')

  const roundIds = new Set(), launchIds = new Set()
  raw.rounds.forEach((round, index) => {
    if (roundIds.has(round?.roundId)) FAIL('INVALID_REQUEST', '$.rounds.' + index, 'Duplicate round id')
    if (launchIds.has(round?.launchId)) FAIL('INVALID_REQUEST', '$.rounds.' + index, 'Duplicate launch id')
    roundIds.add(round?.roundId); launchIds.add(round?.launchId)
    if (!round || round.number !== index + 1) FAIL('INVALID_REQUEST', '$.rounds.' + index + '.number', 'Round numbers must be contiguous from one')
  })
  const ledgerIds = new Set(), fingerprints = new Set()
  raw.ledger.forEach((entry, index) => {
    checkLedgerEntry(entry, '$.ledger.' + index)
    if (ledgerIds.has(entry.id)) FAIL('INVALID_REQUEST', '$.ledger.' + index + '.id', 'Duplicate ledger id')
    if (fingerprints.has(entry.fingerprint)) FAIL('INVALID_REQUEST', '$.ledger.' + index + '.fingerprint', 'Duplicate ledger fingerprint')
    ledgerIds.add(entry.id); fingerprints.add(entry.fingerprint)
    if (!roundIds.has(entry.roundId)) FAIL('INVALID_REQUEST', '$.ledger.' + index + '.roundId', 'Ledger entry references an unknown round')
    if (entry.firstSeenRound > raw.rounds.length) FAIL('INVALID_REQUEST', '$.ledger.' + index + '.firstSeenRound', 'Ledger entry predates the record')
  })
  raw.rounds.forEach((round, index) => checkRound(round, raw, raw.ledger, '$.rounds.' + index))

  const live = raw.rounds.filter(round => round.state === 'in_flight')
  if (live.length > 1) FAIL('INVALID_REQUEST', '$.rounds', 'Exactly one active round is permitted')
  if (raw.activeRoundId === null) {
    if (live.length !== 0) FAIL('INVALID_REQUEST', '$.activeRoundId', 'A live round requires an active round id')
  } else {
    if (live.length !== 1 || live[0].roundId !== raw.activeRoundId) FAIL('INVALID_REQUEST', '$.activeRoundId', 'Active round id does not match the one live round')
    if (raw.state !== 'in_flight') FAIL('INVALID_REQUEST', '$.state', 'An active round requires the in_flight record state')
  }
  if (raw.state === 'in_flight' && raw.activeRoundId === null) FAIL('INVALID_REQUEST', '$.activeRoundId', 'in_flight requires an active round')

  const approved = raw.rounds.filter(round => round.state === 'approved')
  if (raw.approvedRoundId !== null) {
    if (raw.state !== 'approved') FAIL('INVALID_REQUEST', '$.approvedRoundId', 'Only approved records name an approved round')
    if (approved.length !== 1 || approved[0].roundId !== raw.approvedRoundId) FAIL('INVALID_REQUEST', '$.approvedRoundId', 'Approved round id mismatch')
  } else if (approved.length !== 0) {
    FAIL('INVALID_REQUEST', '$.approvedRoundId', 'An approved round requires an approved record')
  }

  const last = raw.rounds.at(-1)
  const noActive = raw.activeRoundId === null && raw.approvedRoundId === null
  if (raw.state === 'required' || raw.state === 'preparing') {
    if (raw.rounds.length || raw.ledger.length) FAIL('INVALID_REQUEST', '$.state', 'A pre-start record has no rounds or ledger')
    if (!noActive) FAIL('INVALID_REQUEST', '$.state', 'A pre-start record has no terminal references')
  } else if (raw.state === 'in_flight') {
    if (!last || last.roundId !== raw.activeRoundId) FAIL('INVALID_REQUEST', '$.state', 'in_flight requires the active round last')
  } else if (raw.state === 'changes_requested') {
    if (!noActive || !last || last.state !== 'changes_requested') FAIL('INVALID_REQUEST', '$.state', 'changes_requested requires the last round to match')
  } else if (raw.state === 'inconclusive') {
    if (!noActive || !last || last.state !== 'inconclusive') FAIL('INVALID_REQUEST', '$.state', 'inconclusive requires the last round to match')
  } else if (raw.state === 'stale') {
    if (!noActive || !last || last.state !== 'stale') FAIL('INVALID_REQUEST', '$.state', 'stale requires the last round to match')
  } else if (raw.state === 'cancelled') {
    if (!noActive || !last || last.state !== 'cancelled') FAIL('INVALID_REQUEST', '$.state', 'cancelled requires the last round to match')
  } else if (raw.state === 'stopped') {
    if (!noActive) FAIL('INVALID_REQUEST', '$.state', 'stopped has no active references')
    if (raw.rounds.length && !['stopped', 'changes_requested', 'stale'].includes(last.state)) FAIL('INVALID_REQUEST', '$.state', 'stopped retains a terminal last round')
  } else if (raw.state === 'approved') {
    if (raw.activeRoundId !== null) FAIL('INVALID_REQUEST', '$.activeRoundId', 'An approved record has no active round')
    const reasons = approvalReasons(raw)
    if (reasons.length) FAIL('INVALID_REQUEST', '$.state', 'Forged or incomplete approval: ' + reasons.join(','))
  }

  if (exhausted) {
    if (raw.state !== 'stopped') FAIL('INVALID_REQUEST', '$.budget.exhausted', 'Only a stopped record may be budget-exhausted')
    if (consumed + 2 <= authorized) FAIL('INVALID_REQUEST', '$.budget.exhausted', 'Exhausted budget must leave no full round')
  }
  if (raw.state === 'approved' && raw.ledger.some(entry => entry.status !== 'closed')) {
    FAIL('INVALID_REQUEST', '$.ledger', 'Approved records have a closed ledger')
  }
  if (raw.rounds.length && (raw.source.planSha256 === null || raw.source.instructionSha256 === null)) FAIL('INVALID_REQUEST', '$.source', 'A started record requires a reviewed source identity')
  return raw
}

/** Strict load/write validator: a persisted record that cannot prove the approved
 * predicate is not approved, and all reconcilable history must be present.
 */
export function validateReviewRecord(raw) {
  try {
    checkRecord(raw)
    return { ok: true, value: raw, diagnostics: [] }
  } catch (error) {
    return { ok: false, value: null, diagnostics: [toDiagnostic(error)] }
  }
}

/** Create the one atomic record. It starts unstarted even when required. */
export function createReviewRecord(input) {
  const code = 'INVALID_REQUEST'
  assertPlainJson(input, code)
  assertReviewKeys(input, ['target', 'workspace', 'required', 'policy', 'budget'], ['target', 'workspace', 'policy', 'budget'], code)
  const required = Object.hasOwn(input, 'required') ? input.required : false
  if (typeof required !== 'boolean') FAIL(code, '$.required', 'Expected boolean')
  assertReviewKeys(input.policy, POLICY_KEYS, ['scopeSha256', 'configSha256', 'roleSha256'], code, '$.policy')
  const policy = normalizePolicy(input.policy)
  assertReviewKeys(input.budget, ['authorized'], ['authorized'], code, '$.budget')
  const authorized = input.budget.authorized
  if (!Number.isSafeInteger(authorized) || authorized < 0 || authorized % 2 !== 0) FAIL('BUDGET_EXHAUSTED', '$.budget.authorized', 'Explicit nonnegative even call budget required')
  parseHandoffRequest({ action: 'bind-worktree', target: input.target, worktreePath: input.workspace })
  if (!input.target.startsWith('.dsh/ulw/plans/')) FAIL(code, '$.target', 'Expected a workspace-relative canonical plan target')
  const record = {
    version: REVIEW_RECORD_VERSION,
    target: input.target,
    workspace: input.workspace,
    required,
    state: 'required',
    revision: 0,
    source: { planSha256: null, instructionSha256: null },
    policy,
    budget: { authorized, consumed: 0, exhausted: false },
    activeRoundId: null,
    approvedRoundId: null,
    rounds: [],
    ledger: [],
  }
  const checked = validateReviewRecord(record)
  if (!checked.ok) FAIL(code, '$', 'Created record failed validation: ' + checked.diagnostics[0].message)
  return snapshot(record)
}

function finish(result) {
  let next
  try { next = snapshot(result.record) } catch { return { ok: false, outcome: 'invalid_transition', record: null, diagnostics: [diagnostic('INVALID_REQUEST', '$', 'Non-serializable next record')], charged: 0, approved: false } }
  const checked = validateReviewRecord(next)
  if (!checked.ok) return { ok: false, outcome: 'invalid_transition', record: null, diagnostics: checked.diagnostics, charged: 0, approved: false }
  return {
    ok: result.ok !== false,
    outcome: result.outcome,
    record: next,
    diagnostics: result.diagnostics ?? [],
    charged: result.charged ?? 0,
    approved: evaluateApproval(next).approved,
  }
}
const rejectEvent = (record, outcome, code, path, message) => ({ ok: false, outcome, record, diagnostics: [diagnostic(code, path, message)], charged: 0 })
const acceptEvent = (record, outcome, extra = {}) => ({ ok: true, outcome, record, diagnostics: extra.diagnostics ?? [], charged: extra.charged ?? 0 })

function normalizeStart(event) {
  assertReviewKeys(event, ['type', 'roundId', 'launchId', 'source', 'policy', 'lanes'], ['type', 'roundId', 'launchId', 'source', 'policy', 'lanes'], 'INVALID_REQUEST')
  const roundId = assertId(event.roundId, '$.roundId')
  const launchId = assertId(event.launchId, '$.launchId')
  const source = normalizeSource(event.source)
  const policy = normalizePolicy(event.policy)
  assertReviewKeys(event.lanes, REVIEW_LANES, REVIEW_LANES, 'INVALID_REQUEST', '$.lanes')
  const lanes = {}
  for (const laneName of REVIEW_LANES) {
    const lane = event.lanes[laneName]
    assertReviewKeys(lane, ['childId', 'runId'], ['childId'], 'INVALID_REQUEST', '$.lanes.' + laneName)
    lanes[laneName] = { childId: assertId(lane.childId, '$.lanes.' + laneName + '.childId') }
    if (Object.hasOwn(lane, 'runId')) lanes[laneName].runId = assertId(lane.runId, '$.lanes.' + laneName + '.runId')
  }
  return { roundId, launchId, source, policy, lanes }
}

function sameStart(round, start) {
  if (round.launchId !== start.launchId || round.source.planSha256 !== start.source.planSha256 || round.source.instructionSha256 !== start.source.instructionSha256 || round.policy.policySha256 !== start.policy.policySha256) return false
  return REVIEW_LANES.every(laneName => {
    const bound = start.lanes[laneName]
    if (round.lanes[laneName].childId !== bound.childId) return false
    return bound.runId === undefined || round.lanes[laneName].runId === bound.runId
  })
}

function onRequire(record, event) {
  assertReviewKeys(event, ['type'], ['type'], 'INVALID_REQUEST')
  if (record.required) return acceptEvent(record, 'required_already')
  return acceptEvent({ ...record, required: true, revision: record.revision + 1 }, 'required')
}

function onStart(record, event) {
  const start = normalizeStart(event)
  if (record.activeRoundId !== null) {
    const active = record.rounds.find(round => round.roundId === record.activeRoundId)
    if (start.roundId === active.roundId) {
      if (sameStart(active, start)) return acceptEvent(record, 'existing_round')
      return rejectEvent(record, 'start_rejected', 'STALE_ARTIFACT', '$.roundId', 'The active round is already bound to a different launch, source or child')
    }
    return rejectEvent(record, 'start_rejected', 'INVALID_REQUEST', '$.roundId', 'Exactly one active round is permitted')
  }
  if (!record.required) return rejectEvent(record, 'start_rejected', 'INVALID_REQUEST', '$.required', 'Review must be explicitly required before starting')
  if (!['required', 'preparing', 'changes_requested', 'stale'].includes(record.state)) return rejectEvent(record, 'start_rejected', 'INVALID_REQUEST', '$.state', 'Review is terminal in state ' + record.state)
  if (start.policy.policySha256 !== record.policy.policySha256) return rejectEvent(record, 'start_rejected', 'STALE_ARTIFACT', '$.policy', 'Policy must be updated by a policy_change event before starting')
  if (record.rounds.some(round => round.roundId === start.roundId)) return rejectEvent(record, 'start_rejected', 'INVALID_REQUEST', '$.roundId', 'Round id was already used')
  if (record.rounds.some(round => round.launchId === start.launchId)) return rejectEvent(record, 'start_rejected', 'INVALID_REQUEST', '$.launchId', 'Launch id was already used')
  const previous = record.rounds.at(-1) ?? null
  if (previous) {
    const progressed = start.source.instructionSha256 !== previous.source.instructionSha256 || start.policy.policySha256 !== previous.policy.policySha256
    if (!progressed) {
      const stopped = { ...record, state: 'stopped', source: start.source, revision: record.revision + 1 }
      return acceptEvent(stopped, 'stopped', { diagnostics: [diagnostic('STALE_ARTIFACT', '$.source', 'No instruction or policy progress since the last round')] })
    }
  }
  if (record.budget.consumed + 2 > record.budget.authorized) {
    const stopped = { ...record, state: 'stopped', budget: { ...record.budget, exhausted: true }, revision: record.revision + 1 }
    return acceptEvent(stopped, 'stopped_budget', { diagnostics: [diagnostic('BUDGET_EXHAUSTED', '$.budget', 'No authorized call budget remains for another round')] })
  }
  const lanes = {}
  for (const laneName of REVIEW_LANES) {
    lanes[laneName] = { childId: start.lanes[laneName].childId, runId: start.lanes[laneName].runId ?? null, status: 'in_flight', result: null, receipt: null, reason: null }
  }
  const round = {
    roundId: start.roundId,
    launchId: start.launchId,
    number: record.rounds.length + 1,
    state: 'in_flight',
    source: start.source,
    policy: start.policy,
    lanes,
    blockersAdded: [],
    blockersClosed: [],
  }
  const next = {
    ...record,
    state: 'in_flight',
    revision: record.revision + 1,
    source: start.source,
    policy: start.policy,
    activeRoundId: start.roundId,
    rounds: [...record.rounds, round],
    budget: { ...record.budget, consumed: record.budget.consumed + 2 },
  }
  return acceptEvent(next, 'started', { charged: 2 })
}

function onBindRun(record, event) {
  assertReviewKeys(event, ['type', 'roundId', 'launchId', 'lane', 'childId', 'runId'], ['type', 'roundId', 'launchId', 'lane', 'childId', 'runId'], 'INVALID_REQUEST')
  const roundId = assertId(event.roundId, '$.roundId')
  const launchId = assertId(event.launchId, '$.launchId')
  const laneName = event.lane
  if (!REVIEW_LANES.includes(laneName)) FAIL('INVALID_REQUEST', '$.lane', 'Unknown review lane')
  const childId = assertId(event.childId, '$.childId')
  const runId = assertId(event.runId, '$.runId')
  if (record.activeRoundId === null) return rejectEvent(record, 'run_rejected', 'STALE_ARTIFACT', '$.roundId', 'No active round')
  if (roundId !== record.activeRoundId || launchId !== record.rounds.find(round => round.roundId === record.activeRoundId).launchId) return rejectEvent(record, 'run_rejected', 'STALE_ARTIFACT', '$.roundId', 'Round or launch identity mismatch')
  const round = record.rounds.find(entry => entry.roundId === roundId)
  const lane = round.lanes[laneName]
  if (lane.childId !== childId) return rejectEvent(record, 'run_rejected', 'STALE_ARTIFACT', '$.childId', 'Child identity mismatch')
  if (lane.status !== 'in_flight') return rejectEvent(record, 'run_rejected', 'STALE_ARTIFACT', '$.lane', 'Lane is already terminal')
  if (lane.runId !== null) return lane.runId === runId ? acceptEvent(record, 'run_already_bound') : rejectEvent(record, 'run_rejected', 'STALE_ARTIFACT', '$.runId', 'Lane is already bound to another run')
  const lanes = { ...round.lanes, [laneName]: { ...lane, runId } }
  const rounds = record.rounds.map(entry => entry.roundId === roundId ? { ...entry, lanes } : entry)
  return acceptEvent({ ...record, rounds, revision: record.revision + 1 }, 'run_bound')
}

function updateLane(record, roundId, laneName, update) {
  const rounds = record.rounds.map(round => round.roundId === roundId ? { ...round, lanes: { ...round.lanes, [laneName]: update(round.lanes[laneName]) } } : round)
  return { ...record, rounds }
}

function staleActive(record) {
  const round = record.rounds.find(entry => entry.roundId === record.activeRoundId)
  const lanes = {}
  for (const laneName of REVIEW_LANES) lanes[laneName] = { ...round.lanes[laneName], status: 'stale', result: null, receipt: null, reason: 'stale' }
  const rounds = record.rounds.map(entry => entry.roundId === round.roundId ? { ...entry, state: 'stale', lanes } : entry)
  return { ...record, state: 'stale', activeRoundId: null, rounds }
}

function finalizeRound(record, roundId) {
  const current = record.rounds.find(round => round.roundId === roundId)
  if (!current || current.state !== 'in_flight') return { record, outcome: null }
  const terminal = REVIEW_LANES.every(laneName => current.lanes[laneName].status !== 'in_flight')
  if (!terminal) return { record, outcome: null }
  const completed = REVIEW_LANES.every(laneName => current.lanes[laneName].status === 'completed')
  const verdicts = REVIEW_LANES.map(laneName => current.lanes[laneName].receipt?.verdict ?? null)
  const replaceIn = (base, round) => ({ ...base, rounds: base.rounds.map(entry => entry.roundId === roundId ? round : entry) })
  const replace = round => replaceIn(record, round)
  if (!completed || verdicts.includes('INCONCLUSIVE')) {
    const next = { ...record, state: 'inconclusive', activeRoundId: null }
    return { record: replaceIn(next, { ...current, state: 'inconclusive' }), outcome: 'inconclusive' }
  }
  if (!verdicts.includes('REJECT')) {
    const closed = []
    const ledger = record.ledger.map(entry => {
      if (entry.status === 'closed') return entry
      closed.push(entry.fingerprint)
      return { ...entry, status: 'closed' }
    })
    const round = { ...current, state: 'approved', blockersClosed: [...current.blockersClosed, ...closed] }
    return {
      record: { ...replace(round), state: 'approved', activeRoundId: null, approvedRoundId: roundId, ledger },
      outcome: 'approved',
    }
  }
  const ledger = record.ledger.map(entry => ({ ...entry }))
  const byFingerprint = new Map(ledger.map((entry, index) => [entry.fingerprint, index]))
  const added = [], reopened = [], seen = new Set()
  for (const laneName of REVIEW_LANES) {
    const lane = current.lanes[laneName]
    if (lane.status !== 'completed' || lane.receipt.verdict !== 'REJECT') continue
    for (const blocker of lane.result.blockers) {
      const fingerprint = blockerFingerprint(blocker)
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      if (byFingerprint.has(fingerprint)) {
        const index = byFingerprint.get(fingerprint)
        if (ledger[index].status === 'closed') {
          ledger[index] = { ...ledger[index], status: 'open' }
          reopened.push(fingerprint)
        }
      } else {
        const usedIds = new Set(ledger.map(entry => entry.id))
        let ledgerId = blocker.id
        if (usedIds.has(ledgerId)) {
          const suffix = ':' + fingerprint.slice(0, 8)
          ledgerId = blocker.id.length + suffix.length <= 200 ? blocker.id + suffix : blocker.id.slice(0, 200 - suffix.length) + suffix
        }
        ledger.push({
          id: ledgerId,
          fingerprint,
          eligibility: blocker.eligibility,
          location: { ...blocker.location },
          evidence: blocker.evidence.map(entry => ({ ...entry })),
          remediation: blocker.remediation,
          status: 'open',
          roundId,
          firstSeenRound: current.number,
        })
        byFingerprint.set(fingerprint, ledger.length - 1)
        added.push(fingerprint)
      }
    }
  }
  const round = { ...current, blockersAdded: [...current.blockersAdded, ...added] }
  if (added.length === 0 && reopened.length === 0) {
    const next = { ...record, state: 'stopped', activeRoundId: null }
    return { record: replaceIn(next, { ...round, state: 'stopped' }), outcome: 'stopped' }
  }
  if (record.budget.consumed + 2 > record.budget.authorized) {
    const next = { ...record, state: 'stopped', activeRoundId: null }
    return { record: { ...replaceIn(next, { ...round, state: 'stopped' }), budget: { ...record.budget, exhausted: true }, ledger }, outcome: 'stopped_budget' }
  }
  return { record: { ...replace({ ...round, state: 'changes_requested' }), state: 'changes_requested', activeRoundId: null, ledger }, outcome: 'changes_requested' }
}

function finalizeAndAdvance(record, roundId, fallbackOutcome) {
  const finalized = finalizeRound(record, roundId)
  return { record: { ...finalized.record, revision: record.revision + 1 }, outcome: finalized.outcome ?? fallbackOutcome }
}

function onLaneResult(record, event) {
  assertReviewKeys(event, ['type', 'roundId', 'launchId', 'lane', 'childId', 'runId', 'coverage', 'result'], ['type', 'roundId', 'launchId', 'lane', 'childId', 'runId', 'coverage', 'result'], 'INVALID_REQUEST')
  const roundId = assertId(event.roundId, '$.roundId')
  const launchId = assertId(event.launchId, '$.launchId')
  const laneName = event.lane
  if (!REVIEW_LANES.includes(laneName)) FAIL('INVALID_REQUEST', '$.lane', 'Unknown review lane')
  const childId = assertId(event.childId, '$.childId')
  const runId = assertId(event.runId, '$.runId')
  checkCoverageShape(event.coverage, '$.coverage')
  if (record.activeRoundId === null) return rejectEvent(record, 'result_rejected', 'STALE_ARTIFACT', '$.roundId', 'No active round accepts this result')
  if (roundId !== record.activeRoundId) return rejectEvent(record, 'result_rejected', 'STALE_ARTIFACT', '$.roundId', 'Result does not belong to the active round')
  const round = record.rounds.find(entry => entry.roundId === record.activeRoundId)
  if (launchId !== round.launchId) return rejectEvent(record, 'result_rejected', 'STALE_ARTIFACT', '$.launchId', 'Launch identity mismatch')
  const lane = round.lanes[laneName]
  if (lane.status !== 'in_flight') return rejectEvent(record, 'result_duplicate', 'STALE_ARTIFACT', '$.lane', 'Lane already has a terminal completion')
  if (childId !== lane.childId || lane.runId === null || runId !== lane.runId) return rejectEvent(record, 'result_rejected', 'STALE_ARTIFACT', '$.childId', 'Child or run identity mismatch')
  const coverage = event.coverage
  if (coverage.complete !== true || coverage.pages < 1 || coverage.totalBytes <= 0 || coverage.deliveredBytes !== coverage.totalBytes) {
    const next = updateLane(record, roundId, laneName, current => ({ ...current, status: 'inconclusive', result: null, receipt: null, reason: 'COVERAGE_INCOMPLETE' }))
    const advanced = finalizeAndAdvance(next, roundId, 'result_accepted')
    return acceptEvent(advanced.record, advanced.outcome)
  }
  if (coverage.planSha256 !== round.source.planSha256 || coverage.instructionSha256 !== round.source.instructionSha256) {
    const next = updateLane(record, roundId, laneName, current => ({ ...current, status: 'inconclusive', result: null, receipt: null, reason: 'STALE_ARTIFACT' }))
    const advanced = finalizeAndAdvance(next, roundId, 'result_accepted')
    return acceptEvent(advanced.record, advanced.outcome)
  }
  const checked = validateReviewResult(event.result, { lane: laneName, roundId, launchId, planSha256: round.source.planSha256 })
  if (!checked.ok) {
    const reason = checked.diagnostics[0].code === 'STALE_ARTIFACT' ? 'STALE_ARTIFACT' : 'INVALID_RESULT'
    const next = updateLane(record, roundId, laneName, current => ({ ...current, status: 'inconclusive', result: null, receipt: null, reason }))
    const advanced = finalizeAndAdvance(next, roundId, 'result_accepted')
    return acceptEvent(advanced.record, advanced.outcome)
  }
  const result = checked.value
  const receipt = {
    lane: laneName,
    roundId,
    launchId,
    childId: lane.childId,
    runId: lane.runId,
    planSha256: round.source.planSha256,
    instructionSha256: round.source.instructionSha256,
    policy: round.policy,
    coverage: {
      complete: true,
      pages: coverage.pages,
      deliveredBytes: coverage.deliveredBytes,
      totalBytes: coverage.totalBytes,
      planSha256: coverage.planSha256,
      instructionSha256: coverage.instructionSha256,
    },
    verdict: result.verdict,
    stopReason: 'completed',
    resultSha256: resultSha256(result),
  }
  const next = updateLane(record, roundId, laneName, current => ({ ...current, status: 'completed', result, receipt, reason: null }))
  const advanced = finalizeAndAdvance(next, roundId, 'result_accepted')
  return acceptEvent(advanced.record, advanced.outcome)
}

function onLaneFailure(record, event) {
  assertReviewKeys(event, ['type', 'roundId', 'launchId', 'lane', 'childId', 'runId', 'stopReason'], ['type', 'roundId', 'launchId', 'lane', 'childId', 'runId', 'stopReason'], 'INVALID_REQUEST')
  const roundId = assertId(event.roundId, '$.roundId')
  const launchId = assertId(event.launchId, '$.launchId')
  const laneName = event.lane
  if (!REVIEW_LANES.includes(laneName)) FAIL('INVALID_REQUEST', '$.lane', 'Unknown review lane')
  const childId = assertId(event.childId, '$.childId')
  const runId = assertId(event.runId, '$.runId')
  if (!REVIEW_LANE_FAILURES.includes(event.stopReason)) FAIL('INVALID_REQUEST', '$.stopReason', 'Unknown lane stop reason')
  if (record.activeRoundId === null) return rejectEvent(record, 'lane_failure_rejected', 'STALE_ARTIFACT', '$.roundId', 'No active round')
  if (roundId !== record.activeRoundId) return rejectEvent(record, 'lane_failure_rejected', 'STALE_ARTIFACT', '$.roundId', 'Result does not belong to the active round')
  const round = record.rounds.find(entry => entry.roundId === record.activeRoundId)
  if (launchId !== round.launchId) return rejectEvent(record, 'lane_failure_rejected', 'STALE_ARTIFACT', '$.launchId', 'Launch identity mismatch')
  const lane = round.lanes[laneName]
  if (lane.status !== 'in_flight') return rejectEvent(record, 'lane_failure_rejected', 'STALE_ARTIFACT', '$.lane', 'Lane is already terminal')
  if (childId !== lane.childId || lane.runId === null || runId !== lane.runId) return rejectEvent(record, 'lane_failure_rejected', 'STALE_ARTIFACT', '$.childId', 'Child or run identity mismatch')
  const next = updateLane(record, roundId, laneName, current => ({ ...current, status: 'failed', result: null, receipt: null, reason: event.stopReason }))
  const advanced = finalizeAndAdvance(next, roundId, 'lane_failed')
  return acceptEvent(advanced.record, advanced.outcome)
}

function onSourceChange(record, event) {
  assertReviewKeys(event, ['type', 'source'], ['type', 'source'], 'INVALID_REQUEST')
  const source = normalizeSource(event.source)
  if (source.planSha256 === record.source.planSha256 && source.instructionSha256 === record.source.instructionSha256) return acceptEvent(record, 'noop')
  if (source.instructionSha256 !== record.source.instructionSha256) {
    if (record.activeRoundId !== null) {
      const stale = staleActive(record)
      return acceptEvent({ ...stale, source, revision: record.revision + 1 }, 'stale')
    }
    if (record.state === 'approved') {
      const rounds = record.rounds.map(round => round.roundId === record.approvedRoundId ? { ...round, state: 'stale' } : round)
      return acceptEvent({ ...record, source, rounds, state: 'stale', approvedRoundId: null, revision: record.revision + 1 }, 'stale')
    }
    return acceptEvent({ ...record, source, revision: record.revision + 1 }, 'source_updated')
  }
  return acceptEvent({ ...record, source, revision: record.revision + 1 }, 'source_tick')
}

function onPolicyChange(record, event) {
  assertReviewKeys(event, ['type', 'policy'], ['type', 'policy'], 'INVALID_REQUEST')
  const policy = normalizePolicy(event.policy)
  if (samePolicy(policy, record.policy)) return acceptEvent(record, 'noop')
  if (record.activeRoundId !== null) {
    const stale = staleActive(record)
    return acceptEvent({ ...stale, policy, revision: record.revision + 1 }, 'stale')
  }
  if (record.state === 'approved') {
    const rounds = record.rounds.map(round => round.roundId === record.approvedRoundId ? { ...round, state: 'stale' } : round)
    return acceptEvent({ ...record, policy, rounds, state: 'stale', approvedRoundId: null, revision: record.revision + 1 }, 'stale')
  }
  return acceptEvent({ ...record, policy, revision: record.revision + 1 }, 'policy_updated')
}

function onCancel(record, event) {
  assertReviewKeys(event, ['type'], ['type'], 'INVALID_REQUEST')
  if (record.activeRoundId === null) return rejectEvent(record, 'cancel_rejected', 'INVALID_REQUEST', '$.state', 'No active round to cancel')
  const round = record.rounds.find(entry => entry.roundId === record.activeRoundId)
  const lanes = {}
  for (const laneName of REVIEW_LANES) {
    const lane = round.lanes[laneName]
    lanes[laneName] = lane.status === 'in_flight' ? { ...lane, status: 'cancelled', result: null, receipt: null, reason: 'cancelled' } : lane
  }
  const rounds = record.rounds.map(entry => entry.roundId === round.roundId ? { ...entry, state: 'cancelled', lanes } : entry)
  return acceptEvent({ ...record, state: 'cancelled', activeRoundId: null, rounds, revision: record.revision + 1 }, 'cancelled')
}

/** Apply one event to a record. Never mutates either argument. Rejected events
 * return the unchanged valid record with ok:false and no charge. Fail-closed
 * transitions (no progress, budget stop) return ok:true with an outcome and a
 * diagnostic; they can only ever move away from approval.
 */
export function reduceReview(record, event) {
  const checkedRecord = validateReviewRecord(record)
  if (!checkedRecord.ok) {
    return { ok: false, outcome: 'invalid_record', record: null, diagnostics: checkedRecord.diagnostics, charged: 0, approved: false }
  }
  let result
  try {
    assertPlainJson(event, 'INVALID_REQUEST')
    if (event === null || typeof event !== 'object' || Array.isArray(event)) FAIL('INVALID_REQUEST', '$', 'Expected an event object')
    const type = event.type
    if (typeof type !== 'string') FAIL('INVALID_REQUEST', '$.type', 'Expected a string event type')
    switch (type) {
      case 'require': result = onRequire(record, event); break
      case 'start': result = onStart(record, event); break
      case 'bind_run': result = onBindRun(record, event); break
      case 'lane_result': result = onLaneResult(record, event); break
      case 'lane_failure': result = onLaneFailure(record, event); break
      case 'source_change': result = onSourceChange(record, event); break
      case 'policy_change': result = onPolicyChange(record, event); break
      case 'cancel': result = onCancel(record, event); break
      default: FAIL('INVALID_REQUEST', '$.type', 'Unknown review event')
    }
  } catch (error) {
    result = { ok: false, outcome: 'invalid_event', record, diagnostics: [toDiagnostic(error)], charged: 0 }
  }
  return finish(result)
}

export function reduceReviewRecord(record, event) {
  return reduceReview(record, event)
}
