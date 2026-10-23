# 保真记录（dsh-omo）


> 发布名：本文写于项目名为 dsh-omo 的阶段。npm 包与 GitHub 仓库现以 **dsh-ulw-plan** 发布；bundle row id 仍为 `omo`，文中 `dsh-omo` 指同一实现。

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

## 3. T1：产物根改名（`.omo` → `.dsh/ulw`，57 处 / 6 个含命中的文件）

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

> 以下第 1–5 条为 A4 重构**之前**的历史记录，已被第 9 节的 DSH-native 形态取代，保留作对照；第 6–10 条仍然有效。

1. ~~`task` **一律内联**~~（A4 后 `task` 工具已删除，见第 9 节）。
2. ~~没有 `task_output` / `task_send` / `task_cancel`~~（A4 后委托走原生 `subagent`，通知与 `send_message` / `interrupt_agent` 均为 Host 自带）。
3. 没有 continuation hook：`create_goal` 承担；P7 可补 `agent/turn-stopping`。
4. ~~`category` 不选模型、不传 preset~~（A4 后 `category` 连参数都不是，只是 prompt 词汇）。
5. ~~plan-gate 三条件~~（A4 后由命令校验承担：`/ulw-review` 校验唯一目标，两条角色命令在 `execute` 模式拒绝）。
6. 新增 `/ulw-mode off|plan|execute` 逃生口（omo 没有）。
7. ledger 路径为 `.dsh/ulw/ulw-execute/ledger.jsonl`（机械改名结果）。
8. guard 只管 `write` / `edit`，不管 `bash`（与 omo 的 prometheus-md-only 一致）。
9. `ulw-execute` 正文保留 omo 的 `codex:<session_id>` 原文；A2 的 DSH 兼容节把前缀映射为 `dsh:<session_id>`，并声明「本节优先」。
10. 模型通过 `skill` 工具自行加载 `ulw-plan` 不会切换模式：投影只折叠用户显式 `/ulw-plan` 的 `skill-invocation` 消息。要进入 plan 模式请用 `/ulw-plan` 或 `/ulw-mode plan`。

## 8. 重新验证

```bash
node --check skills/ulw-plan/scripts/scaffold-plan.mjs
node --check skills/ulw-plan/scripts/plan-templates.mjs
grep -rn '\.omo' skills | wc -l   # 期望 0（lib/load.js 的运行时改名是唯一登记例外；prompts/ 目录已不存在）
sha256sum skills/ulw-plan/SKILL.md skills/ulw-plan/references/full-workflow.md \
  skills/ulw-plan/references/intent-clear.md skills/ulw-plan/references/intent-unclear.md \
  skills/ulw-plan/scripts/plan-templates.mjs skills/ulw-plan/scripts/scaffold-plan.mjs \
  skills/ulw-execute/SKILL.md
# 第 2 节表格是 A4 之前的历史基线：只有 scaffold-plan.mjs 仍逐行可比；
# 其余文件的现行哈希见第 9 节表格
```

行为证据见 `.dsh/ulw/evidence/<session>/<goalId>/a<attempt>/task-3-dsh-omo-plugin.log`。

## 9. A4：DSH-native 重构（2026-10-23）

按「更适配 DSH」的目标重构 agent 面：**不再移植 omo 的 agent 机制**。第 2 节的表格从此是历史基线（记录最初端口的字节来源），本节记录现行状态。

### 9.1 删除（本地首创组件，无 omo 对应字节）

| 组件 | 原职责 | 取代者 |
| --- | --- | --- |
| `lib/presets.js` | 注册 4 个只读 preset（explore / librarian / plan-consultant / plan-reviewer，`omo ` 前缀） | 角色契约注入（consult/review 命令）+ 研究车道模板（原生 `subagent` 派发） |
| `lib/task-tool.js` | omo `task` 委托面的内联移植（`subagent_type` + `category` + 深度闸） | Host 原生 `subagent` / `subagent_fork` / `send_message` / `interrupt_agent` |
| `lib/gate.js` | plan-gate 三条件（mode、产物、唯一 plan 路径） | `/ulw-review` 的目标校验（`lib/commands.js` 的 `resolveReviewTarget`）+ execute 模式拒绝 |
| `prompts/explore.md`、`prompts/librarian.md` | preset persona | 折叠进 `references/research-lanes.md` 的车道模板（改写：LSP→grep/glob/read，bash broker→web_search/web_fetch，`%%CURRENT_YEAR%%` 令牌改为相对表述） |

### 9.2 移动（字节不变，仅换目录）

| 原路径 | 新路径 | sha256（与第 2 节一致，证明未改字节） |
| --- | --- | --- |
| `prompts/plan-consultant.md` | `skills/ulw-plan/references/plan-consultant.md` | `c2d43353bcdde5dc0d5d239d4a35e444e120e3a3d55e09f26127a27188dc1405` |
| `prompts/plan-reviewer.md` | `skills/ulw-plan/references/plan-reviewer.md` | `0192c47a9f94bc198a479614bd5316bb516f57b4bfa5e3b3e9891abcd66e10db` |

移入技能 references 后，契约成为技能可引用的单源：plan 工作流就地采纳（`references/plan-consultant.md` / `references/plan-reviewer.md`），`/ulw-consult` / `/ulw-review` 命令注入同一文件文本。

### 9.3 新增

- `lib/commands.js` 的 `/ulw-consult <request>` 与 `/ulw-review <plan-path>`：校验后通过 `agent.followup` 把契约文本注入当前会话（与 Host `/goal` 同一座桥；消息构造为 `{role:'user', source:{kind:'user'}}`，不依赖 `@deepseek-ai/dsh-llm`）。`/ulw-review` 同时注入字面绝对路径与命令时刻的 sha256。
- `skills/ulw-plan/references/research-lanes.md`（sha256 `dd352b75057ad6951d595d0718127ca0965224335f55d407a8780dda00cff216`）：explorer / librarian 车道模板 + 原生 `subagent` 派发纪律。

### 9.4 改写（omo 字节 + 结构性手改）

| 文件 | 现行 sha256 | 改动性质 |
| --- | --- | --- |
| `skills/ulw-plan/SKILL.md` | `8138d3e6b1cbdf4b69b4bff018bf6e2f1e04087d0e2952a83ebba0bdc1ee92d8` | A1 的三行 DSH 注记替换为「Delegation (DSH-native)」节；评审修饰段改为会话内评审表述 |
| `skills/ulw-plan/references/full-workflow.md` | `5c9bc3a1f426e45f0b0dc50e1747c3bd1e0a482a384ff84bf2ee0df296aa9164` | 双车道（momus+oracle）评审契约改写为单车道会话内评审步骤；跨代理 receipt/lifecycle/intake JSON 契约替换为草稿内轮次台账；有界收敛契约保留；Phase 3 的 Metis 步骤改为会话内 consultant 步骤；委托纪律改为原生 `subagent` 措辞 |
| `skills/ulw-plan/references/intent-clear.md` | `a5ebf52f9e0003fa7a4c548608d24581c3d8f888e7fa7df7b5ac33cc87e812ed` | 「run mandatory Metis / dual review」改为会话内 consultant 步骤与评审步骤（含 `/ulw-review` 提示） |
| `skills/ulw-plan/references/intent-unclear.md` | `76dd5622626930b05ed1b27f646a9e9161bac93505330fb5baa1f65a1d05f283` | 同上；TRIVIAL-TIER GUARD 的 Momus/Metis 措辞改为 review step / consultant pass |
| `skills/ulw-plan/scripts/plan-templates.mjs` | `94efd31eb0d01135b203b904eac51849492350d202bee16bf1418067bcbb92b7` | draft 的 review 状态从 momus/independent 双车道改为单车道（status/target/round_id/plan_sha256/rounds） |
| `skills/ulw-plan/references/dsh-harness.md` | `c6cde9a719d3aa00841534ae3413084fc9c2a33d5551b6e40819f4a3095dfc48` | 整体重写（A3 原文的 DSH-native 版）：原生工具映射、两条角色命令、tier 词汇化、guard 不拦委托 |
| `skills/ulw-execute/SKILL.md` | `f15863e81e2818cfb99b2939157217f6c06a9c5046e5714862c7fc03f5a42508` | A2 的 DSH 兼容表改写为原生 `subagent` + `/ulw-review`；delegation router 的 `task(category=…)` 示例改为 tier 进 prompt 的说明 |

### 9.5 语义要点

1. **high-accuracy 评审并入 plan 步骤**：评审是规划会话内的工作流步骤（同一契约、单车道、有界收敛、草稿内轮次收据 + 交付前活体摘要复验），不再派生 momus/oracle 子代理；`/ulw-review` 是用户按需触发同一契约的会话内命令。
2. **explore / librarian 集成而非独立 agent**：研究车道是提示词模板，经 Host 原生 `subagent` / `subagent_fork` 派发；规划会话自身的 read / glob / grep / web 工具也始终可用。
3. **consultant / reviewer 只以命令提供**：`/ulw-consult`、`/ulw-review` 在对话中直接调用（`execute` 模式拒绝，命令文本给出退出口）；plan 工作流内部则直接采纳 references 里的同一契约，不经命令。
4. **评审独立性换形**：双 fresh-preset 子代理的独立性由「契约驱动 + 磁盘重读 + 摘要锚定 + 有界收敛」承担——这是与 omo 的真实行为差异，不是缺陷隐瞒。
