---
name: ulw-plan
description: DeepSeek Harness mapping for the ulw-plan workflow - tool names, role aliases, artifact paths, scaffold invocation, and the plan-mode write guard.
metadata:
  short-description: DSH tool mapping and guard behavior for ulw-plan
---

# ulw-plan on DeepSeek Harness

This reference is the DSH-specific mapping for the workflow above. OpenCode/Codex tool names in inherited examples translate to the tools below. If a code block elsewhere conflicts with this file, this file wins for DSH.

## Tool mapping

| omo / OpenCode | DeepSeek Harness |
| --- | --- |
| `task(subagent_type="explore"\|"librarian"\|"plan-consultant"\|"plan-reviewer")` | the inline `task` tool with the same `subagent_type`; the child's result is returned in this same turn |
| `task(subagent_type="metis"\|"momus"\|"oracle")` | `task` aliases; see the alias table below |
| `task(category="…")` | `task({category})`; refused while the session mode is `plan`, allowed in `execute` / `off` |
| `background_output(task_id=…)` / `task_send` / `task_cancel` | no equivalent: `task` always waits inline. Use `send_message` / `interrupt_agent` for separately spawned `subagent` children |
| `read` / `find` / `ls` | `read` / `glob` / `grep` (the read-only role presets expose exactly these plus `bash`) |
| `lsp_*` tools | not present; combine `grep`, `glob`, and `read` |

Every `task` call is self-contained: the child does not inherit this conversation, so the prompt must carry the TASK / DELIVERABLE / SCOPE / VERIFY assignment and any context the child needs.

## Role aliases

| Alias | Preset | Plan-gate |
| --- | --- | --- |
| `explore` | `explore` | none |
| `librarian` | `librarian` | none |
| `plan-consultant` | `plan-consultant` | mode=`plan` and a draft/plan artifact exists |
| `metis` | `plan-consultant` | same as `plan-consultant` |
| `plan-reviewer` | `plan-reviewer` | same as `plan-consultant`, plus exactly one existing `.dsh/ulw/plans/<slug>.md` path in the prompt |
| `momus` | `plan-reviewer` | same as `plan-reviewer` |
| `oracle` | `plan-reviewer` | same as `plan-reviewer` |

`momus` and `oracle` are separate fresh-preset children, so the dual high-accuracy review keeps its independence. In `mode = execute`, every consultant/reviewer type is refused: review ends when execution starts.

## Category semantics

`category` names an implementer class: `quick`, `unspecified-low`, `unspecified-high`, `visual-engineering`, `writing`, `git`, `deep-low`, `deep-high`, `ultrabrain`, `architect`. On DSH it selects **no model** and passes **no preset**: the child inherits the parent preset (a complete, writable worker). Categories are the planner's forbidden move - they spawn implementers - so `task(category=…)` is refused while `mode = plan`.

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
- It does not decide the plan-gate; `task` enforces that separately.

The mode is per session and survives resume/fork through the `ulwMode` projection. Subagent sessions start at `off`, so a read-only role child is never fenced by the parent's planning mode.
