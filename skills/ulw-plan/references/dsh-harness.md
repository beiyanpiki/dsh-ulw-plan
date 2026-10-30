---
name: ulw-plan
description: DeepSeek Harness mapping for the ulw-plan workflow - native delegation tools, the review and handoff entrypoints, the role commands, artifact paths, scaffold invocation, and the write guards.
metadata:
  short-description: DSH tool mapping, review state and guard behavior for ulw-plan
---

# ulw-plan on DeepSeek Harness

This reference is the DSH-specific mapping for the workflow above. OpenCode/Codex tool names in inherited examples translate to the surfaces below. If a code block elsewhere conflicts with this file, this file wins for DSH.

DSH ships **no omo role agents**. Research delegation rides the Host's native subagent tools with the role written into the prompt; the consultant and reviewer lanes are contracts, reached through the skill's own references or through the role commands.

## Tool mapping

| omo / OpenCode | DeepSeek Harness |
| --- | --- |
| `task(subagent_type="explore")` | `subagent({description, prompt})` with the explorer lane template from `references/research-lanes.md` pasted into the prompt |
| `task(subagent_type="librarian")` | `subagent({description, prompt})` with the librarian lane template from `references/research-lanes.md` |
| `task(subagent_type="metis"|"plan-consultant")` | run the consultant contract inline: `references/plan-consultant.md`, or the `/ulw-consult <request>` command |
| `task(subagent_type="momus"|"oracle"|"plan-reviewer")` | `ulw_review` Host dual review, or `/ulw-review <plan-path>` for the same Host round; the lane contracts are `references/plan-reviewer.md` and `references/plan-adversarial-reviewer.md` |
| handoff, worktree binding, no-plan bootstrap | `ulw_handoff` actions `check`, `bootstrap`, `bind-worktree` |
| `task(category="…")` (implementer) | the native `subagent` tool after `/ulw-execute`; state the category tier in the child's prompt (no category parameter exists) |
| `background_output(task_id=…)` / `task_send` / `task_cancel` | no equivalents: the native tools notify on completion; use `send_message` / `interrupt_agent` on the child id |
| `read` / `find` / `ls` | `read` / `glob` / `grep` |
| `lsp_*` tools | not present; combine `grep`, `glob`, and `read` |

Every delegation is self-contained: the child does not share this conversation, so the prompt must carry the TASK / DELIVERABLE / SCOPE / VERIFY assignment and any context the child needs.

## Review and handoff entrypoints

| Entrypoint | Registered identity | Parameters |
| --- | --- | --- |
| `ulw_review` | actions `require`, `start`, `wait`, `status`, `cancel` | `action` plus exactly one selector: `target` (canonical `.dsh/ulw/plans/<slug>.md`) or `roundId` returned by a previous call. `require` and `start` require `target`; `wait` is normally called with the returned `roundId`. No `approved`, `verdict`, `sessionId` or `prompt` field exists. |
| `ulw_handoff` | actions `check`, `bootstrap`, `bind-worktree` | `action` plus the canonical `target`; `bind-worktree` additionally requires an absolute `worktreePath`. No `lease`, `approved`, `sessionId` or `prompt` field exists. |
| `/ulw-review <plan-path>` | enhanced slash command | Validates one existing canonical plan target, registers `require`, starts `start`, and returns an ACCEPTED receipt with a followup to `wait`; it never reports a completed review. Refused only while the session holds an active execution lease (`HANDOFF_ACTIVE_EXECUTE`); an execute session without a lease still accepts one round (accepted, not completed), and plan/off are unaffected. |

### Review order

1. **Draft stage:** `ulw_review({ action: "require", target: ".dsh/ulw/plans/<slug>.md" })`. This only raises the requirement; a draft `review_required: false` or an older draft cannot clear it, and it never approves.
2. **After the complete plan** (todos + TL;DR): run `node "<skill-root>/scripts/plan-lint.mjs" .dsh/ulw/plans/<slug>.md --json` and require exit 0.
3. `ulw_review({ action: "start", target: ".dsh/ulw/plans/<slug>.md" })` - preflights and starts both lanes; its result is ACCEPTED, not completed.
4. `ulw_review({ action: "wait", roundId: "<round.roundId from start>" })` - only `approved: true` with `completed: true` after both bound lane receipts is approval.

Do not edit Scope, task text, QA or references between `start` and the two lane results; a source change makes the round stale. `status` is a read-only snapshot and `cancel` stops the active round; neither approves. The draft's `review` fields are summaries - never hand-fill `approved`, a verdict, a lane receipt or a round id the Host did not return. An old draft's `OKAY` or `status: approved` is history, not authority. If the enhanced service is unavailable, a required review cannot complete and the plan cannot be handed off; ordinary plans keep working.

### Handoff order (execution)

1. `ulw_handoff({ action: "check", target: ".dsh/ulw/plans/<slug>.md" })` before any product write. An ordinary plan gets an ordinary lease with zero reviewer starts. A required plan gets no lease until a persisted Host dual approval matches the live raw and instruction digests, the policy, and both lane receipts; `HANDOFF_NOT_APPROVED` names `review`/`start` as the next action.
2. `ulw_handoff({ action: "bind-worktree", target, worktreePath: "<absolute path>" })` after creating or reusing the task-owned worktree; the Host verifies read-only git membership and the instruction hash.
3. `ulw_handoff({ action: "bootstrap", target })` for a no-plan bootstrap. The Host calls the scaffold function through the narrow interface, writes the draft/plan, and returns `nextAction: "review"` or `"check"`; it does not shell out to `scaffold-plan.mjs`.
4. The lease is revocable: every later side effect revalidates the plan instruction hash. A legal status tick keeps it; editing task text, Scope or QA revokes it and execution must return to plan review.

## Review cost, recovery and gates

- **Cost:** `require`, `status` and reading the draft cost no model calls. Each `start` round reserves exactly two lane calls (one per lane); `wait` adds none. Enhanced review is disabled by default and requires an explicit even `callBudget`, two distinct normalized models and both routes; an ordinary plan starts **zero** reviewer calls. When the budget cannot fund another full round, the Host returns `BUDGET_EXHAUSTED` - stop and report, never skip a lane or silently fall back to an inline approval. A refusal for an active execution lease starts no round and spends no model calls.
- **Recovery:** a dropped turn resumes with `ulw_review` action `status` (or `wait` on the accepted `roundId`), never by re-running `start` as a vote. `WAIT_UNAVAILABLE` means no runtime handles remain in this process: read `status`, then use a new target or a human reset; a terminal record (`approved`, `changes_requested`, `inconclusive`, `stale`, `cancelled`, `stopped`) is history and can never reopen. A source edit makes the round stale - `start` a fresh round after the fix. `CAPABILITY_UNAVAILABLE` makes a required plan unreviewable and non-handoffable; ordinary plans continue. A slash-command refusal under an active lease has no accepted round to resume: inspect the handoff, or leave execute with `/ulw-mode plan`/`off`.
- **Gates:** only `approved: true` + `completed: true` after both complete lane receipts is approval. `require` only raises; `status`/`cancel` never approve; the draft and its `review` fields are summaries. A required `ulw_handoff` `check` fails closed until the persisted approval matches the live raw/instruction digests and policy; an active execution lease closes the `/ulw-review` command, and F1-F4 product acceptance never uses it.

## The two role commands

Both commands inject their contract into THIS conversation as an ordinary user turn - the same session then performs the role inline. Nothing is spawned.

| Command | Effect |
| --- | --- |
| `/ulw-consult <request>` | validates the request, injects `references/plan-consultant.md` plus the request text; refused in `execute` mode |
| `/ulw-review <plan-path>` | validates one existing `.dsh/ulw/plans/<slug>.md` target (YAML refused, containment enforced), then the enhanced router registers the requirement and accepts one Host round. The receipt says plainly it is NOT a completed review; the followup asks the conversation to call `ulw_review` action `wait`/ `status`. Refused only while the session holds an active execution lease (`HANDOFF_ACTIVE_EXECUTE`); an execute session without a lease accepts one round (accepted, not completed). Without the enhanced router, the command injects `references/plan-reviewer.md` plus the literal path and digest for a standalone inline pass. |

`/ulw-review` is the user-facing way to demand the high-accuracy review on demand: when the plan workflow requires the review, the planner drives the same Host round through `ulw_review`; when the USER types `/ulw-review`, the command does the registration and start. An accepted round is never a completed review, and an old draft OKAY is never a dual receipt.

The commands append ordinary user turns through the same Host bridge `/goal` uses, so the injected contract is model-visible and durable in the session log. `/ulw-consult` is refused in `execute` mode. `/ulw-review` is not refused by the mode alone: an execute session without a lease accepts one round (the receipt says accepted, not completed), and only an active execution lease - `ulw_handoff` state `leased` or `bound` - refuses it with `HANDOFF_ACTIVE_EXECUTE`, because plan review must not run inside the handed-off execution. Plan/off are unaffected, and `/ulw-mode plan` (or `off`) reopens the command outside the lease. An unreadable handoff lookup fails closed as `CAPABILITY_UNAVAILABLE`, never as "no lease". An active lease closes the `/ulw-review` command, and F1-F4 product acceptance must not call it.

## Implementer tiers (vocabulary only)

omo's `category` names an implementer class: `quick`, `unspecified-low`, `unspecified-high`, `visual-engineering`, `writing`, `git`, `deep-low`, `deep-high`, `ultrabrain`, `architect`. DSH has no category parameter and no model chain: the category survives as **prompt vocabulary** - the planner's `Recommended task executor category:` annotations tell the ulw-execute worker how to size and word each native `subagent` dispatch. While the session mode is `plan`, implementer dispatch is forbidden by the workflow (the planner never implements); the write guard below is the hard boundary that keeps product files read-only anyway.

## Artifacts and scaffold

```text
.dsh/ulw/drafts/<slug>.md
.dsh/ulw/plans/<slug>.md
.dsh/ulw/boulder.json
.dsh/ulw/ulw-execute/ledger.jsonl
```

The generator is still the script shipped with this skill. `<skill-root>` is absolute in the injected skill body:

```text
node "<skill-root>/scripts/scaffold-plan.mjs" <slug> [--clear|--unclear] --draft-only [--review-required]
```

Rerun without `--draft-only` after approval. The script self-guards its own writes: every target must resolve under `.dsh/ulw/`, each existing ancestor is checked for symlinks, and an existing non-artifact file is refused with exit code 1. A plain rerun on an existing draft or plan is a safe no-op; never overwrite an old draft or plan, and never migrate its OKAY or `status: approved` into a Host approval.

## Plan-mode and execute-mode guards

While the session's `ulwMode` projection says `plan`, the Host `write` and `edit` tools are refused unless the resolved `file_path` stays inside `.dsh/ulw/`. The refusal names the exits: `/ulw-mode execute` runs the plan; `/ulw-mode off` leaves the workflow.

In `execute` mode the projection alone is not authorization. The Host-owned handoff lease is the gate: until `ulw_handoff check` issues a verified lease, product `write`/`edit`, `bash`, implementation spawns and unknown side-effect tools are refused, while read-only tools, plan/draft authoring, and the review/handoff/goal/todo tools stay available. A verified required lease revalidates the instruction hash on every side-effect entry. A failed re-check (missing, revoked, expired or source-drifted) refuses the side effect and names `check`/`review`.

What the guards deliberately do **not** do:

- The plan-mode guard does not block `bash` (same boundary as omo's prometheus-md-only hook). Execution-mode `bash` is gated by the handoff lease, so bootstrap must use `ulw_handoff` action `bootstrap` instead of running the scaffold through a shell.
- They do not block `read`, `glob`, `grep`, or any read-only tool.
- They do not gate research delegation: research lanes through the native `subagent` tool stay available while planning - the workflow's no-implementer rule lives in the skill contract, and the write guard keeps this session's own hands off product files.

The mode is per session and survives resume/fork through the `ulwMode` projection. Subagent sessions start at `off`, so a research child is never fenced by the parent's planning mode. Execution handoff and leases are Host-owned; a model cannot mint or hand-fill either.
