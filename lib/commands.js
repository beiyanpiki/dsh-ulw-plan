/**
 * The three `/ulw-*` commands: the workflow's conversation surface.
 *
 * - `/ulw-mode off|plan|execute` - the mode escape hatch (projection-driven).
 * - `/ulw-consult <request>` - inject the pre-planning consultant contract
 *   into this conversation (`agent.followup`), so the SAME session performs
 *   the consultation inline. No separate agent is spawned.
 * - `/ulw-review <plan-path>` - validate one plan target, then inject the
 *   plan-reviewer contract plus the literal path and its sha256. The
 *   high-accuracy review is a step of the planning conversation, not a
 *   dispatched subagent.
 *
 * Both injections queue an ordinary user turn through `agent.followup`, the
 * same Host bridge `/goal` uses for command-driven model input. The command
 * result shown to the human stays a one-line receipt.
 *
 * @module dsh-ulw-plan/commands
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { readAsset, renameArtifacts } from './load.js'
import { artifactPath, isWithin } from './paths.js'
import { ULW_MODES } from './projection.js'

/** Command name without the leading slash. */
export const ULW_MODE_COMMAND = 'ulw-mode'

/** Usage text shown on an invalid invocation. */
export const ULW_MODE_USAGE = 'Usage: /ulw-mode off|plan|execute'

/** Command names of the two in-conversation role commands. */
export const ULW_CONSULT_COMMAND = 'ulw-consult'
export const ULW_REVIEW_COMMAND = 'ulw-review'

/** Usage texts for the role commands. */
export const ULW_CONSULT_USAGE = 'Usage: /ulw-consult <request to consult on>'
export const ULW_REVIEW_USAGE = 'Usage: /ulw-review <path to a .dsh/ulw/plans/<slug>.md plan>'

/** Refusal when execution has already started; names the exit like the guard does. */
const EXECUTE_MODE_REFUSAL =
  'ulw-execute mode: planning roles are closed once execution starts. ' +
  'Run /ulw-mode off (or /ulw-mode plan) first, then retry.'

/** Stable refusal code when a plan review is asked for inside an active execute lease. */
export const HANDOFF_ACTIVE_EXECUTE = 'HANDOFF_ACTIVE_EXECUTE'

/** Refusal for an active handed-off execute; F2 must not run inside an active lease. */
const ACTIVE_LEASE_REFUSAL =
  'ulw review: ' + HANDOFF_ACTIVE_EXECUTE + ': this execute session already holds an active handoff lease, ' +
  'so the plan review is closed during the handed-off execution. No review round was accepted and no approval ' +
  'exists. Inspect the active handoff with ulw_handoff check, or run /ulw-mode plan to review outside execution.'

/** Refusal when the handoff exists but its lease state cannot be read: fail closed. */
const HANDOFF_LOOKUP_REFUSAL =
  'ulw review: CAPABILITY_UNAVAILABLE: the execution handoff lease state could not be read; ' +
  'no review round was accepted and no approval exists.'

/**
 * Load one role contract from the ulw-plan skill references.
 * @param name - `plan-consultant` or `plan-reviewer`.
 * @returns the contract text with the artifact-root transform applied.
 */
export function loadContract(name) {
  return renameArtifacts(readAsset(`skills/ulw-plan/references/${name}.md`))
}

/**
 * Read the effective working directory for one agent.
 * @param ctx - context providing `workingDirectory`.
 * @param agent - the agent that received the command.
 * @returns its absolute directory.
 */
function cwdOf(ctx, agent) {
  return agent.session.header.cwd ?? ctx.workingDirectory.get(agent.session)
}

/**
 * The projected `ulwMode` for one agent's session.
 * @param ctx - context providing `sessionProjections`.
 * @param agent - the agent that received the command.
 * @returns the current mode (`off` when no state exists yet).
 */
function modeOf(ctx, agent) {
  return ctx.sessionProjections.stateOf(agent.session, 'ulwMode')?.mode ?? 'off'
}

/**
 * Resolve whether an active execution lease is in force for one agent.
 *
 * The shared rule (lib/review-handoff.js `reviewAllowed`, plan design line 53)
 * is: plan review is allowed in plan/off and in execute until a handoff lease
 * is obtained; once a lease is issued (`leased` or `bound`) the plan review is
 * closed because it must not run inside the active handed-off execution. The
 * shipped entrypoint injects `ctx.handoff` from the review sub-effect; an old
 * Host or a standalone composition has none, and then no lease can exist.
 *
 * @param ctx - context possibly carrying the Host-owned `handoff` authority.
 * @param agent - the agent that received the command.
 * @returns `{ known: false }` when the lookup failed, else `{ known: true, active }`.
 */
function activeExecuteLease(ctx, agent) {
  const handoff = ctx.handoff
  if (handoff === undefined || handoff === null || typeof handoff.stateForSession !== 'function') {
    return { known: true, active: false }
  }
  const session = agent?.session
  const sessionId = session?.header?.id ?? session?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    // An unidentifiable session can never hold a lease: ulw_handoff refuses
    // HANDOFF_AUTHOR_REQUIRED, so there is no active lease to refuse here.
    return { known: true, active: false }
  }
  let state
  try {
    state = handoff.stateForSession(sessionId)
  } catch {
    return { known: false, active: false }
  }
  if (state === null || state === undefined) return { known: true, active: false }
  if (typeof state.then === 'function') {
    // An asynchronous lookup would silently fail open on a Promise; refuse it.
    return { known: false, active: false }
  }
  const lease = state.lease
  if (lease === null || lease === undefined) return { known: true, active: false }
  return { known: true, active: state.status === 'leased' || state.status === 'bound' }
}

/**
 * Queue one ordinary user turn carrying the injected contract text.
 * Mirrors `/goal`'s bridge: a command handler may not send the command to the
 * model itself, but it can queue model-visible followup content.
 * @param agent - the receiving agent.
 * @param text - the complete injected instruction text.
 */
function injectFollowup(agent, text) {
  const message = Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'user' }),
  })
  agent.followup(message)
}

/**
 * Validate and resolve one `/ulw-review` target argument.
 * @param target - the raw argument (a plan path, relative or absolute).
 * @param cwd - the session working directory used to resolve it.
 * @returns `{ ok: true, absolute, digest }`, or `{ ok: false, error }`.
 */
export function resolveReviewTarget(target, cwd) {
  const trimmed = typeof target === 'string' ? target.trim() : ''
  if (trimmed === '') {
    return { ok: false, error: `${ULW_REVIEW_USAGE}` }
  }
  if (/\.ya?ml$/i.test(trimmed)) {
    return { ok: false, error: `${trimmed}: YAML plans are not reviewable; pass the .dsh/ulw/plans/<slug>.md markdown plan.` }
  }
  if (!/\.md$/i.test(trimmed)) {
    return { ok: false, error: `${ULW_REVIEW_USAGE}` }
  }
  const plansRoot = artifactPath(cwd, 'plans')
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed)
  if (!isWithin(plansRoot, absolute)) {
    return { ok: false, error: `${trimmed}: review targets must live under .dsh/ulw/plans/` }
  }
  let info
  try {
    info = statSync(absolute)
  } catch {
    return { ok: false, error: `${trimmed}: no such plan file (resolved to ${absolute}).` }
  }
  if (!info.isFile()) {
    return { ok: false, error: `${trimmed}: not a regular plan file.` }
  }
  const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex')
  return { ok: true, absolute, digest }
}

/**
 * Compose the `/ulw-review` injection: framing, the literal target, its
 * digest, and the reviewer contract.
 * @param absolute - the resolved absolute plan path.
 * @param digest - the plan's sha256 at command time.
 * @param contract - the plan-reviewer contract text.
 * @returns the complete followup text.
 */
export function buildReviewInjection(absolute, digest, contract) {
  return (
    'The user ran `/ulw-review` in this conversation. Adopt the plan-reviewer contract below ' +
    'and perform the review inline, in this same conversation - no subagent dispatch.\n\n' +
    `Review target (the ONLY plan in scope): ${absolute}\n` +
    `Plan sha256 at command time: ${digest}\n` +
    'Re-read the file from disk NOW and treat the on-disk bytes as the only source of truth; ' +
    'if what you read does not look like the artifact this digest was taken from, stop and report ' +
    'the drift instead of reviewing a moving target.\n\n' +
    `${contract}\n\n` +
    'End with the contract\'s verdict format ([OKAY] or [REJECT] with at most 3 blocking issues). ' +
    'After the verdict, resume your previous role in this conversation.'
  )
}

/**
 * Compose the `/ulw-consult` injection: framing, the consultant contract,
 * and the user's request.
 * @param request - the consultation request text.
 * @param contract - the plan-consultant contract text.
 * @returns the complete followup text.
 */
export function buildConsultInjection(request, contract) {
  return (
    'The user ran `/ulw-consult` in this conversation. Adopt the pre-planning consultant ' +
    'contract below, analyze the request that follows, and deliver the contract\'s output ' +
    'format (intent classification, pre-analysis findings, questions, risks, directives) - ' +
    'inline, in this same conversation, no subagent dispatch.\n\n' +
    `${contract}\n\n` +
    `Consultation request:\n${request}`
  )
}

/**
 * Register `/ulw-mode`.
 * @param ctx - context providing `commands`.
 * @returns the exact disposer that unregisters the command.
 */
function registerModeCommand(ctx) {
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

/**
 * Register `/ulw-consult`.
 * @param ctx - context providing `commands`, `sessionProjections`, `workingDirectory`.
 * @returns the exact disposer that unregisters the command.
 */
function registerConsultCommand(ctx) {
  return ctx.commands.register({
    name: ULW_CONSULT_COMMAND,
    description: 'Consult the plan consultant on a request, inline in this conversation',
    input: { hint: '<request to consult on>' },
    handler(invocation) {
      const request = invocation.rawInput.trim()
      if (request === '') return { kind: 'error', text: ULW_CONSULT_USAGE }
      if (modeOf(ctx, invocation.agent) === 'execute') return { kind: 'error', text: EXECUTE_MODE_REFUSAL }
      injectFollowup(invocation.agent, buildConsultInjection(request, loadContract('plan-consultant')))
      return { kind: 'success', text: `ulw consult: consultant contract injected for this conversation.` }
    },
  })
}

/**
 * Register `/ulw-review`.
 *
 * The shipped entrypoint (lib/index.js) always supplies `options.review`, the
 * enhanced router owned by lib/review-tools.js. That router shares the one
 * coordinator with the `ulw_review` tool: the command registers the
 * requirement, accepts a round asynchronously, returns a receipt that states
 * plainly it is NOT a completed review, and asks the conversation through the
 * existing followup bridge to poll wait/status. A capability failure is
 * surfaced as an error receipt and injects nothing.
 *
 * Without `options.review` the function keeps the historical inline contract
 * injection so a caller that composes this module standalone (the unit tests,
 * or a third-party plugin) is not broken. The shipped entrypoint never takes
 * that path, so no inline approval is reachable from the installed plugin.
 *
 * Execute mode is not refused wholesale: plan review is legal before a handoff
 * lease (the selection/bootstrap stage a required plan needs). Only an active
 * issued lease closes it, because the plan review must not run inside the
 * handed-off execution; that refusal is the stable `HANDOFF_ACTIVE_EXECUTE`
 * code, distinct from a capability diagnostic.
 *
 * @param ctx - context providing `commands`, `sessionProjections`, `workingDirectory`.
 * @param options - optional `{ review }` enhanced router.
 * @returns the exact disposer that unregisters the command.
 */
function registerReviewCommand(ctx, options = {}) {
  const router = options.review
  return ctx.commands.register({
    name: ULW_REVIEW_COMMAND,
    description: router
      ? 'Accept the Host-owned dual plan review round for one plan (NOT a completed review)'
      : 'Run the strict plan review on one plan, inline in this conversation',
    input: { hint: '<plan path under .dsh/ulw/plans/>' },
    handler(invocation) {
      if (modeOf(ctx, invocation.agent) === 'execute') {
        const lease = activeExecuteLease(ctx, invocation.agent)
        if (!lease.known) return { kind: 'error', text: HANDOFF_LOOKUP_REFUSAL }
        if (lease.active) return { kind: 'error', text: ACTIVE_LEASE_REFUSAL }
      }
      const cwd = cwdOf(ctx, invocation.agent)
      const target = resolveReviewTarget(invocation.rawInput, cwd)
      if (router !== undefined && router !== null) {
        if (typeof router.command !== 'function') {
          return { kind: 'error', text: 'ulw review: CAPABILITY_UNAVAILABLE: the enhanced review router is malformed; no review was accepted.' }
        }
        return Promise.resolve()
          .then(() => router.command({ target, agent: invocation.agent, signal: invocation.signal }))
          .then((outcome) => {
            if (!outcome || !outcome.result || (outcome.result.kind !== 'success' && outcome.result.kind !== 'error')) {
              return { kind: 'error', text: 'ulw review: the enhanced review entrypoint returned no result; no approval exists.' }
            }
            if (typeof outcome.followup === 'string' && outcome.followup !== '') {
              injectFollowup(invocation.agent, outcome.followup)
            }
            return outcome.result
          })
          .catch((error) => ({
            kind: 'error',
            text: `ulw review: ${error instanceof Error ? error.message : String(error)}; no review was accepted and no approval exists.`,
          }))
      }
      if (!target.ok) return { kind: 'error', text: target.error }
      injectFollowup(
        invocation.agent,
        buildReviewInjection(target.absolute, target.digest, loadContract('plan-reviewer')),
      )
      return { kind: 'success', text: `ulw review: ${target.absolute} - reviewer contract injected.` }
    },
  })
}

/**
 * Register every ulw command on the Host context.
 * The mode command only validates and reports; the commands service already
 * appends the `command/run` event the `ulwMode` projection folds, so
 * `recordInput` must stay at its default `true` for `/ulw-mode`.
 * @param ctx - context providing `commands`.
 * @param options - optional `{ review }` enhanced router for `/ulw-review`.
 * @returns a single disposer that unregisters all three commands.
 */
export function registerCommands(ctx, options = {}) {
  const disposers = [
    registerModeCommand(ctx),
    registerConsultCommand(ctx),
    registerReviewCommand(ctx, options),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
