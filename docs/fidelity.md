# 保真记录（dsh-omo）

> 这份文档回答一个问题：**哪些字节来自 omo，哪些是本地改动？** 每一条都可机械复核，不靠肉眼。

## 1. 源

- 仓库：`code-yeongyu/oh-my-openagent`
- commit：`4c6a902`
- 获取方式（本机 `/tmp` 在沙箱里按 shell 隔离，所以快照放在 workspace 的 gitignored 目录）：

```bash
mkdir -p .vendor/omo-pinned && cd .vendor/omo-pinned
curl -sSL -o omo.tar.gz https://codeload.github.com/code-yeongyu/oh-my-openagent/tar.gz/4c6a902
tar xzf omo.tar.gz && mv oh-my-openagent-4c6a902 src && rm omo.tar.gz
```

| 本地目标 | omo 源 |
| --- | --- |
| `prompts/explore.md` | `packages/senpi-task/src/agents/builtin/explore.ts`（`EXPLORE_AGENT.prompt`） |
| `prompts/librarian.md` | `.../librarian.ts`（`LIBRARIAN_AGENT.prompt`） |
| `prompts/plan-consultant.md` | `.../plan-consultant.ts`（`PLAN_CONSULTANT_AGENT.prompt`） |
| `prompts/plan-reviewer.md` | `.../plan-reviewer.ts`（`PLAN_REVIEWER_AGENT.prompt`） |
| `skills/ulw-plan/SKILL.md` | `packages/shared-skills/skills/ulw-plan/SKILL.md` |
| `skills/ulw-plan/references/full-workflow.md` | 同名 |
| `skills/ulw-plan/references/intent-clear.md` | 同名 |
| `skills/ulw-plan/references/intent-unclear.md` | 同名 |
| `skills/ulw-plan/scripts/plan-templates.mjs` | 同名 |
| `skills/ulw-plan/scripts/scaffold-plan.mjs` | 同名 |
| `skills/ulw-execute/SKILL.md` | `packages/shared-skills/skills/ulw-execute/SKILL.md` |

四个 prompt 是用 Node 26 直接 import `.ts` 模块后取 `prompt` **运行时值**，不是从源码里正则抠出来的；因此模板字面量里的转义（`\``）与插值都已按真实值处理。

## 2. 11 个移植文件与 sha256

| 文件 | sha256 |
| --- | --- |
| `prompts/explore.md` | `4f2288fd6fc7c3356a51570f54354b5e52eb7af5a0a2c2960f907178104e5ba1` |
| `prompts/librarian.md` | `20a1eeab16e4166705979131ba7bb88f8b65d2423cc13f11bba1abe1daebdb4c` |
| `prompts/plan-consultant.md` | `c2d43353bcdde5dc0d5d239d4a35e444e120e3a3d55e09f26127a27188dc1405` |
| `prompts/plan-reviewer.md` | `0192c47a9f94bc198a479614bd5316bb516f57b4bfa5e3b3e9891abcd66e10db` |
| `skills/ulw-plan/SKILL.md` | `3bbb644a64afc51f3c54b42e141cb758e16883a65abf01970f76bcfcef82caf0` |
| `skills/ulw-plan/references/full-workflow.md` | `f7a3b9b24deab0bfc24c3c3470e5b63ef404b33095479c0f6cfc7821e59aa652` |
| `skills/ulw-plan/references/intent-clear.md` | `4d0817bd547a76810035440309cc11aacb27a26eaf2c22153e4faa6e522a10f6` |
| `skills/ulw-plan/references/intent-unclear.md` | `452d0624d7d105e455b7382219ea650be9810cab25c69fa2a52148d12becc688` |
| `skills/ulw-plan/scripts/plan-templates.mjs` | `a43c5f7adeab92ff6d15da075f71900e4f0aceecd3640d71b6bbd9bddefbb432` |
| `skills/ulw-plan/scripts/scaffold-plan.mjs` | `6fe5e80a75521b2585b2aebe18b5895d2f01e93c0621f54e471e4aa639ca39f0` |
| `skills/ulw-execute/SKILL.md` | `22f83b84b961f37947979a1eeabf86d8e7ba669461344ea1931fbe6d16f5d1b3` |

A3 是新增文件，不在 11 个「移植」文件里：`skills/ulw-plan/references/dsh-harness.md`（sha256 `e923e6f1ae947db68756100cb37eae4aaf6d870355032f6e5cc104b5908c66e5`）。

## 3. T1：产物根改名（`.omo` → `.dsh/ulw`，57 处 / 6 文件）

| 文件 | 处数 | 处理 |
| --- | --- | --- |
| `prompts/plan-reviewer.md` | 6 | 纯文本替换 |
| `skills/ulw-plan/SKILL.md` | 4 | 纯文本替换 |
| `skills/ulw-plan/references/full-workflow.md` | 18 | 纯文本替换（含 review 合约 JSON 里的路径） |
| `skills/ulw-plan/references/intent-clear.md` | 0 | 不动 |
| `skills/ulw-plan/references/intent-unclear.md` | 0 | 不动 |
| `skills/ulw-plan/scripts/plan-templates.mjs` | 7 | 纯文本替换（含 `.dsh/ulw/evidence/`） |
| `skills/ulw-plan/scripts/scaffold-plan.mjs` | 10 | **4 处结构性手改** + 其余 6 处文本替换 |
| `skills/ulw-execute/SKILL.md` | 12 | 纯文本替换 |
| **合计** | **57** | 53 处文本 + 4 处结构 |

### 3.1 `scaffold-plan.mjs` 的 4 处结构性手改

盲替换会把正则变成 `/\.dsh/ulw/`（Windows 路径失配），把 join 变成单段 `".dsh/ulw"`，所以这 4 处必须手写：

```js
// 1) 行 67（源） / 67（本地）
- if (!/(^|[/\\])\.omo([/\\]|$)/i.test(rel)) {
+ if (!/(^|[/\\])\.dsh(?:[/\\])ulw([/\\]|$)/i.test(rel)) {

// 2) 行 109
- const omoRoot = resolve(cwd, ".omo");
+ const omoRoot = resolve(cwd, ".dsh", "ulw");

// 3) 行 160
- const draftRel = join(".omo", "drafts", `${slug}.md`);
+ const draftRel = join(".dsh", "ulw", "drafts", `${slug}.md`);

// 4) 行 163
- const planRel = join(".omo", "plans", `${slug}.md`);
+ const planRel = join(".dsh", "ulw", "plans", `${slug}.md`);
```

### 3.2 反向 diff 的方法

对每个**非** `scaffold-plan.mjs` 的文本文件：

```bash
sed 's#\.dsh/ulw#.omo#g' <本地文件> | diff - <omo 源文件>
```

- `intent-clear.md` / `intent-unclear.md`：diff 必须为空。
- `full-workflow.md` / `plan-templates.mjs`：diff 必须为空。
- `ulw-plan/SKILL.md`：diff 只允许 A1 的 3 行（加 1 行空行）。
- `ulw-execute/SKILL.md`：diff 只允许 A2 整节。
- `prompts/*`：`plan-reviewer` 反向变成 `.omo` 后必须为空；`librarian` 还要把 `%%CURRENT_YEAR%%` 换回当前年份；其余两个必须为空。
- `scaffold-plan.mjs`：diff 只允许上面 4 个结构行（每个一行 `-` / 一行 `+`）。

更严格的机械证明在首次执行的 `verify-fidelity.mjs`（一次性脚本，见证据目录）：它不做 diff，而是从 omo 源**重新生成**每个目标（应用 T1、4 处结构手改、A1/A2、`%%CURRENT_YEAR%%`），再要求与磁盘文件逐字节相等。11 个文件全部 PASS。

## 4. A1：`skills/ulw-plan/SKILL.md` 追加 3 行

```text
DSH: delegate with the inline `task` tool — `task({subagent_type: "explore"|"librarian"|"plan-consultant"|"plan-reviewer"|"metis"|"momus"|"oracle", description, prompt})` returns the child's result in this same turn.
DSH: `category=` is refused in plan mode (it spawns an implementer); use it only after `/ulw-execute`.
DSH: the exact tool mapping, the three aliases, and the plan-mode write guard live in `references/dsh-harness.md`.
```

## 5. A2：`skills/ulw-execute/SKILL.md` 新增整节

```markdown
## DeepSeek Harness Tool Compatibility

Translate any Codex-only tool name in an inherited example to its DeepSeek Harness equivalent. **This section wins** over the Codex sections above when both apply.

| Codex example | DSH tool to use |
| --- | --- |
| `multi_agent_v1.spawn_agent({"message":"TASK: act as a rigorous reviewer. ..."})` | `task({subagent_type: "plan-reviewer", description, prompt})` — the result returns inline in this same turn |
| worker `multi_agent_v1.spawn_agent({"message":"TASK: act as <role>. ..."})` | `task({category: "<quick|unspecified-low|unspecified-high|visual-engineering|writing|git|deep-low|deep-high|ultrabrain|architect>", description, prompt})` — allowed outside plan mode only, and it inherits the parent preset |
| `background_output(task_id="...")` / `multi_agent_v1.wait_agent(...)` | `task` has already waited for the child; its result is the deliverable. Use `subagent` only for non-omo delegation, and there is no `task_output` / `task_send` / `task_cancel` |
| `multi_agent_v1.send_input(...)` | `send_message(agent_id, message)` |
| `multi_agent_v1.close_agent(...)` | `interrupt_agent(agent_id)` |
| `codex:<session_id>` in `.dsh/ulw/boulder.json` | `dsh:<session_id>` |

When translating `load_skills=[...]`, load the named skill inside the spawned agent's `prompt` with the `skill` tool (or name `/ulw-plan` / `/ulw-execute`); the child does not inherit the parent's loaded skill bodies. If a code block below conflicts with this section, this section wins.

```

## 6. A3：新增 `skills/ulw-plan/references/dsh-harness.md`

````markdown
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
````

## 7. 已知行为差异

1. `task` **一律内联**：`run_in_background` 被接受但不改变行为（本项目不实现后台投递）。
2. 没有 `task_output` / `task_send` / `task_cancel`；用 `send_message` / `interrupt_agent` / 结算通知。
3. 没有 continuation hook：`create_goal` 承担；P7 可补 `agent/turn-stopping`。
4. `category` 不选模型、不传 preset；worker 继承父 preset（完整可写）。
5. plan-gate 的「本会话触碰过 plan」简化为「`mode = plan` 且 `.dsh/ulw/drafts|plans` 有产物」。
6. 新增 `/ulw-mode off|plan|execute` 逃生口（omo 没有）。
7. ledger 路径为 `.dsh/ulw/ulw-execute/ledger.jsonl`（机械改名结果）。
8. guard 只管 `write` / `edit`，不管 `bash`（与 omo 的 prometheus-md-only 一致）。

## 8. 重新验证

```bash
node --check skills/ulw-plan/scripts/scaffold-plan.mjs
node --check skills/ulw-plan/scripts/plan-templates.mjs
grep -rn '\.omo' skills prompts | wc -l   # 期望 0（lib/load.js 的运行时改名是唯一登记命中）
sha256sum prompts/*.md skills/ulw-plan/SKILL.md skills/ulw-plan/references/full-workflow.md \
  skills/ulw-plan/references/intent-clear.md skills/ulw-plan/references/intent-unclear.md \
  skills/ulw-plan/scripts/plan-templates.mjs skills/ulw-plan/scripts/scaffold-plan.mjs \
  skills/ulw-execute/SKILL.md
# 与第 2 节表格逐行比对
```

行为证据见 `.dsh/ulw/evidence/<session>/<goalId>/a<attempt>/task-3-dsh-omo-plugin.log`。
