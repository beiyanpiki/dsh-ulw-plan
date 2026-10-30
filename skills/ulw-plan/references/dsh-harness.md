---
name: ulw-plan
description: DeepSeek Harness mapping for the ulw-plan workflow - native delegation tools, the two role commands, artifact paths, scaffold invocation, and the plan-mode write guard.
metadata:
  short-description: DSH tool mapping and guard behavior for ulw-plan
---

# ulw-plan on DeepSeek Harness

This reference is the DSH-specific mapping for the workflow above. OpenCode/Codex tool names in inherited examples translate to the surfaces below. If a code block elsewhere conflicts with this file, this file wins for DSH.

DSH ships **no omo role agents**. Research delegation rides the Host's native subagent tools with the role written into the prompt; the consultant and reviewer roles are **in-conversation contracts**, reachable either through the skill's own references or through two slash commands.

## Tool mapping

| omo / OpenCode | DeepSeek Harness |
| --- | --- |
| `task(subagent_type="explore")` | `subagent({description, prompt})` with the explorer lane template from `references/research-lanes.md` pasted into the prompt |
| `task(subagent_type="librarian")` | `subagent({description, prompt})` with the librarian lane template from `references/research-lanes.md` |
| `task(subagent_type="metis"|"plan-consultant")` | run the consultant contract inline: `references/plan-consultant.md`, or the `/ulw-consult <request>` command |
| `task(subagent_type="momus"|"oracle"|"plan-reviewer")` | run the reviewer contract inline: `references/plan-reviewer.md`, or the `/ulw-review <plan-path>` command |
| `task(category="…")` (implementer) | the native `subagent` tool after `/ulw-execute`; state the category tier in the child's prompt (no category parameter exists) |
| `background_output(task_id=…)` / `task_send` / `task_cancel` | no equivalents: the native tools notify on completion; use `send_message` / `interrupt_agent` on the child id |
| `read` / `find` / `ls` | `read` / `glob` / `grep` |
| `lsp_*` tools | not present; combine `grep`, `glob`, and `read` |

Every delegation is self-contained: the child does not share this conversation, so the prompt must carry the TASK / DELIVERABLE / SCOPE / VERIFY assignment and any context the child needs.

## The two role commands

Both commands inject their contract into THIS conversation as an ordinary user turn - the same session then performs the role inline. Nothing is spawned.

| Command | Effect |
| --- | --- |
| `/ulw-consult <request>` | validates the request, injects `references/plan-consultant.md` plus the request text; refused in `execute` mode |
| `/ulw-review <plan-path>` | validates one existing `.dsh/ulw/plans/<slug>.md` target (YAML refused, containment enforced), computes its sha256, and injects `references/plan-reviewer.md` plus the literal path and digest; refused in `execute` mode |

`/ulw-review` is also the user-facing way to demand the high-accuracy review on demand: when the plan workflow requires the review, the planner runs the same reviewer contract itself as a plan step (`references/full-workflow.md`); when the USER types `/ulw-review`, the command does the injection for this conversation.

The commands append ordinary user turns through the same Host bridge `/goal` uses, so the injected contract is model-visible and durable in the session log. In `mode = execute` both are refused: review ends when execution starts (`/ulw-mode off` or `plan` reopens them).

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

Rerun without `--draft-only` after approval. The script self-guards its own writes: every target must resolve under `.dsh/ulw/`, each existing ancestor is checked for symlinks, and an existing non-artifact file is refused with exit code 1. This is why the plan-mode write guard does not block `bash`: the mandated generator must keep working.

## Plan-mode write guard

While the session's `ulwMode` projection says `plan`, the Host `write` and `edit` tools are refused unless the resolved `file_path` stays inside `.dsh/ulw/`. The refusal names the exits: `/ulw-mode execute` runs the plan; `/ulw-mode off` leaves the workflow.

What the guard deliberately does **not** do:

- It does not block `bash` (same boundary as omo's prometheus-md-only hook).
- It does not block `read`, `glob`, `grep`, or any read-only tool.
- It does not gate delegation: research lanes through the native `subagent` tool stay available while planning - the workflow's no-implementer rule lives in the skill contract, and the write guard keeps this session's own hands off product files.

The mode is per session and survives resume/fork through the `ulwMode` projection. Subagent sessions start at `off`, so a research child is never fenced by the parent's planning mode.
