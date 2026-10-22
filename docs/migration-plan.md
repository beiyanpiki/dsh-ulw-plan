# omo → dsh 迁移方案 v2：explore & plan & execute

> 把 omo（oh-my-openagent）的 **explore → plan → execute** 作为**一个 DSH 插件**（`dsh-omo`）迁移到 DeepSeek Harness：
> 4 个 agent（`explore` / `librarian` / `plan-consultant` / `plan-reviewer`）+ 2 个指令（`/ulw-plan` / `/ulw-execute`），
> 纪律不靠散文，靠**会话模式投影 + 写入门禁 guard + 严格 plan-gate**硬化。

- 勘察对象 A：`code-yeongyu/oh-my-openagent` @ `4c6a902`（`dev`）
- 勘察对象 B：本机 DSH **0.2.1-rc.2**，profile `web`，当前预设 `ptc`
- 目标仓库：`/home/miku/dsh-omo`（空仓库；profile 已有软链 `dsh-omo -> /home/miku/dsh-omo`，尚未进 `dsh.profile.bundles`）
- 可执行的实施计划（ulw-plan 格式，11 个 todo + F1-F4）：`.dsh/ulw/plans/dsh-omo-plugin.md`

---

## 0. 已锁定的决策（v2 相对 v1 的变更）

| # | 决策 | 选择 | 后果 |
|---|---|---|---|
| D1 | 规划期门禁 | **硬化**：`tools.guard` 在 plan 模式下拒绝 `write`/`edit`，只放行产物目录 | 多一个 guard 模块；omo 原文的「不实现」变成事实 |
| D2 | plan-gate | **严格**：会话模式投影复刻 omo 三条件 | 需要 projection；子代理拉起受会话状态约束 |
| D3 | 产物目录 | **`.dsh/ulw`**（原 `.omo`） | 57 处文案/脚本改名，保真策略从「纯逐字」变为「逐字 + 1 个机械变换」 |
| D4 | `task` 交付形态 | **一律内联**（`delivery:'caller'` + `await activation.result`） | 结果直接在工具返回里；`run_in_background` 仅兼容接受、不改变行为（Effort 降到 Medium 的手段） |
| D5 | 委派工具形态 | **保留独立 `task` 工具** | 零 preset 接管、零 `task(...)` 改写 |

> D5 的调查结论（值得留档）：`insert` 只能进入 `group: true` 的行（`applyEntryPatches` 中 `if (!target.group) warn("not a group")`），
> 而 preset 行既非 group，`buildMap` 也不递归进它的 `config.plugins`，因此**无法就地给 shipped `subagent` 行加 `allowedAgentPresets`**；
> 想用 `subagent(agent_preset=…)` 必须整体接管 `preset-ptc`（冻结一份 shipped preset），且 omo 的调用照样要改写。
> 权衡后回到独立 `task`：**零改写 + 零冻结**。

---

## 1. 勘察结论

### 1.1 omo 的真实结构

```
用户 ──/ulw-plan /ulw-execute──> 主 agent（orchestrator）
                                   ├── task(subagent_type="explore"|"librarian"|"metis"|"momus"|"oracle")
                                   ├── task(category="quick"|"ultrabrain"|…)
                                   └── 产物： draft / plan / boulder / ledger
```

素材来源（本方案全部内容均取自这些文件）：

| 类别 | omo 路径 | 行数 |
|---|---|---|
| role prompt（senpi 版） | `packages/senpi-task/src/agents/builtin/{explore,librarian,plan-consultant,plan-reviewer}.ts` | 100 / 87 / 285 / 212 |
| 规划技能 | `packages/shared-skills/skills/ulw-plan/{SKILL.md,references/*,scripts/*}` | 98 + 344 + 367 |
| 执行技能 | `packages/shared-skills/skills/ulw-execute/SKILL.md` | 246 |
| 门禁参考 | `packages/senpi-task/src/agents/invocation-guard.ts` | plan-gated 三条件 |
| 产品语义 | `docs/guide/orchestration.md`、`docs/reference/features.md` | 权威行为说明 |

四条硬约束：**Planner 不实现 / Executor 不实现 / plan-gate / 产物即状态**。

### 1.2 DSH 的可迁移面（逐项核实）

| 机制 | 证据 | 用途 |
|---|---|---|
| `ctx.skills.register({userInvocable})` | `dsh-tool-skill` 在 `agent/pre-step` 用 `SKILL_GESTURE` 注入正文 | `/ulw-plan`、`/ulw-execute` |
| `ctx.skills.register({resourceBase})` | `renderSkillContent` 渲染 `Base directory for this skill: …` | `node "<skill-root>/scripts/…"` 可解析 |
| `ctx.agentPresets.register()` | registry `register → activate → mountPreset` | 4 个 role agent |
| `dsh-tool-fs` 的 `read/write/edit` 开关 | `Config = z.object({read, readImage, write, edit, …})` | 只读角色真正没有写工具 |
| `ctx.subagents.startActivation({delivery})` | `startLocal`；`activation.result` 结算时 resolve | 内联 `task` |
| `sessionProjections.register/stateOf` | `stateOf()` 同步、惰性折叠日志 | 会话模式（plan/execute/off） |
| `ctx.tools.guard(fn)` | 全局 guard，`exec.agent` + `exec.arguments` 可用 | 规划期拦写 |
| `ctx.commands.register()` | 每次执行自动写已知事件 `command/run`（含 `args`，`recordInput` 默认 true） | `/ulw-mode` 逃生口，投影可折叠 |
| `session.header.delegationDepth` | `SessionHeader` | 禁递归委派 |

### 1.3 差异矩阵

| omo | DSH | 处理 |
|---|---|---|
| `task(subagent_type/category)` | 无 | 新写 `task` 工具（签名对齐） |
| 子代理 `tools[] allowlist` | agent preset + `tool-fs` 开关 | 4 个 preset |
| `metis` / `momus` / `oracle` | 无 | `task` 别名 |
| plan mode 黏性 | 无（DSH 的 plan-mode 会禁止写产物） | 自建投影，不用 `dsh-plan-mode` |
| prometheus-md-only hook | 无 | 自建 guard（同样**只管 Write/Edit，不管 Bash**） |
| `.omo` 产物 | 路径改名 | `.dsh/ulw` |
| Boulder 续跑 hook | `agent/turn-stopping` | P7 可选 |
| `category` 模型链 | `agentOptions` | P6 可选 |

---

## 2. 目标架构

```
┌──────────────────────────── Host 平面：dsh-omo ────────────────────────────┐
│  apply(ctx)                                                                │
│   ├─ projection  "ulwMode"        {off|plan|execute}  ← skill 调用 / /ulw-mode │
│   ├─ guard                        plan 模式下 deny write/edit（放行产物目录） │
│   ├─ command     /ulw-mode        command/run → 投影折叠                    │
│   ├─ tools       task             内联，subagent_type | category          │
│   ├─ skills      ulw-plan / ulw-execute（user+model invocable）             │
│   └─ presets     explore / librarian / plan-consultant / plan-reviewer     │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
   用户 /ulw-plan ──> 主 agent ──> task(subagent_type="explore") ──> spawn + agentPreset
                                    │                                   │
                                    │                    ┌──────────────┴──────────────┐
                                    │                    │ persona = omo 原文           │
                                    │                    │ tool-fs (write/edit: false)  │
                                    │                    │ glob/grep · bash · web(仅 librarian) │
                                    │                    └─────────────────────────────┘
                                    └── 产物： .dsh/ulw/{drafts,plans,boulder.json,ulw-execute/ledger.jsonl}
```

**一个 Host 行**：`hindsight` 已证明 Host 注册的 tools/skills 对 preset 会话可见。若放 preset，需要整体覆盖 shipped 列表，升级即碎。

---

## 3. 映射表

### 3.1 Agent

| omo | DSH | preset | 工具 | 门禁 |
|---|---|---|---|---|
| `explore` | preset | `explore` | `read`,`glob`,`grep`,`bash` | 无 |
| `librarian` | preset | `librarian` | 同上 + `web_search`,`web_fetch` | 无 |
| `plan-consultant` | preset | `plan-consultant` | 同 explore | `mode === 'plan'` 且存在 plan 产物 |
| `plan-reviewer` | preset | `plan-reviewer` | 同 explore | 同上 + prompt 内恰好一个 plan 路径 |
| `metis` | alias | → `plan-consultant` | | 同 plan-consultant |
| `momus` | alias | → `plan-reviewer` | | 同 plan-reviewer |
| `oracle` | alias | → `plan-reviewer`（新会话即独立） | | 同 plan-reviewer |
| worker | `category=` | 无（继承父 preset） | 完整可写 | `mode !== 'plan'` 允许（plan 模式拒绝，复刻 omo「planner 不得派发 category」） |

> 三个别名是**补充的 agent**：让 `full-workflow.md` 里 `task(subagent_type="momus"/"oracle"/"metis")` 零改写可跑。

### 3.2 指令与会话状态

| 触发 | 结果 |
|---|---|
| `/ulw-plan …` | skill 正文注入；投影 `mode = 'plan'` |
| `/ulw-execute …` | skill 正文注入；投影 `mode = 'execute'` |
| `/ulw-mode off\|plan\|execute` | commands 服务自动写 `command/run`（含 args），投影折叠为显式覆盖；**新增的逃生口** |
| `off`（默认） | 不干预 |

> 为什么需要 `/ulw-mode`：计划模式是黏性的，而 DSH 没有"换 agent"来退出。没有逃生口，用户在一个会话里会永久失去写权限。
> 这是相对 omo 的唯一新增人类指令，记录在 `docs/fidelity.md`。

### 3.3 产物（`.dsh/ulw`）

```
.dsh/ulw/drafts/<slug>.md
.dsh/ulw/plans/<slug>.md
.dsh/ulw/boulder.json
.dsh/ulw/ulw-execute/ledger.jsonl      # 机械改名结果，见 §6.1
```

---

## 4. 仓库布局

```
/home/miku/dsh-omo
├── package.json                 # name=dsh-omo, type=module, main=lib/index.js, dsh.bundle.patch, engines.dsh
├── cordis.patch.yml             # - insert: [{ id: omo, name: dsh-omo }]
├── README.md                    # 安装/使用/与 omo 的差异
├── lib/
│   ├── index.js                 # 装配：projection → guard → command → tools → skills → presets
│   ├── paths.js                 # 产物根 .dsh/ulw、containment、跨平台 join
│   ├── load.js                  # package 资产读取 + frontmatter 剥离 + 改名变换
│   ├── presets.js               # 4 个 PresetDefinition
│   ├── projection.js            # ulwMode 折叠
│   ├── guard.js                 # plan 模式拦截 write/edit
│   ├── gate.js                  # plan-gate（模式 + 产物 + 单一路径）
│   ├── task-tool.js             # task：内联、别名、category、取消回收
│   └── commands.js              # /ulw-mode
├── prompts/                     # 4 个 role prompt（逐字 + T1 改名）
├── skills/
│   ├── ulw-plan/{SKILL.md,references/*,scripts/*}
│   └── ulw-execute/SKILL.md
├── docs/{migration-plan.md,fidelity.md,architecture.md}
└── test/{paths,guard,gate,projection,task-tool}.test.mjs
```

**手写 ESM、零运行时依赖、零构建**：不 `import` 任何 `@deepseek-ai/*`（profile 的 `node_modules/@deepseek-ai` 只有 `cosmokit`/`schemastery`）。
服务用 `ctx.inject`；工具用普通对象 `{name,description,parameters,output:{schema,render},execute}`。

---

## 5. 组件规格

### 5.1 入口

```js
export const name = 'dsh-omo'
export const inject = ['skills', 'tools', 'subagents', 'agentPresets',
                       'sessionProjections', 'commands', 'workingDirectory']

export async function apply(ctx) {
  const disposers = [
    registerProjection(ctx),   // 先注册，guard/gate 依赖它
    registerGuard(ctx),
    registerCommand(ctx),
    ctx.tools.register(taskTool(ctx)),
    registerSkills(ctx),
    await registerPresets(ctx),
  ]
  ctx.effect(() => () => { for (const d of disposers.reverse()) d() }, 'dsh-omo')
}
```

### 5.2 会话模式投影

```js
ctx.sessionProjections.register({
  key: 'ulwMode',
  stateVersion: 1,
  stateSchema: { parse: (v) => (v && typeof v.mode === 'string' ? v : { mode: 'off' }) }, // 鸭子类型，见 R9
  init: () => ({ mode: 'off' }),
  apply(state, event) {
    // 1) 用户显式切换：commands 服务自动写入 command/run（已知事件，带 args）
    if (event.type === 'command/run' && event.data?.name === 'ulw-mode') {
      const mode = String(event.data.args ?? '').trim()
      if (mode === 'off' || mode === 'plan' || mode === 'execute') return { mode }
    }
    // 2) 自然模式：用户直接敲 /ulw-plan 或 /ulw-execute 时注入的 skill 调用消息
    if (event.type === 'user/message' && event.data?.source?.kind === 'skill-invocation') {
      if (event.data.source.name === 'ulw-plan') return { mode: 'plan' }
      if (event.data.source.name === 'ulw-execute') return { mode: 'execute' }
    }
    return state   // 必须返回同一引用，否则下游全量重算
  },
})
```

- 只折叠两类**已知**事件；未命中返回原引用（投影契约要求）。
- 持久化由投影框架负责：进程重启/恢复后 `stateOf` 自动重放。
- **为什么不用自定义事件**：持久化读路径会拒绝日志中 `KNOWN_SESSION_EVENT_TYPES` 之外的**非 ignorable** 事件；
  唯一能写 `ignorable` 记录的 `appendPluginRecord` 只能从 `@deepseek-ai/dsh-session` import，
  而插件无法解析该包；若强行装第二份拷贝，其模块级 `commitPluginRecord` 静态钩子为 undefined，必然崩溃。
  因此只用已知事件（`command/run` + `user/message`），零自定义类型。

### 5.3 规划期 guard

```js
const MUTATORS = new Set(['write', 'edit'])

ctx.tools.guard((exec) => {
  const agent = exec.agent
  if (!agent) return
  if (ctx.sessionProjections.stateOf(agent.session, 'ulwMode')?.mode !== 'plan') return
  if (!MUTATORS.has(exec.name)) return
  const cwd = agent.session.header.cwd ?? ctx.workingDirectory.get(agent.session)
  const target = exec.arguments?.file_path
  if (typeof target === 'string' && isUnderArtifactRoot(cwd, target)) return   // 允许写 plan/draft
  return 'ulw-plan mode: planning only. Write only under .dsh/ulw/. ' +
         'Switch with /ulw-mode execute (run the plan) or /ulw-mode off (leave the workflow).'
})
```

- **只管 `write`/`edit`，不管 `bash`** —— 与 omo 的 prometheus-md-only 完全一致（`scaffold-plan.mjs` 就是靠 Bash 出产物）。
- `isUnderArtifactRoot` 做 `resolve` + 相对路径 containment，拒绝 `..` 与符号链接逃逸。
- 子代理会话模式为 `off`，不受影响；worker 也只应在 `execute` 模式被派发。

### 5.4 plan-gate（复刻 omo 三条件）

| omo 条件 | DSH 判定 |
|---|---|
| `requiresSkills: ['ulw-plan']` | `stateOf(...,'ulwMode').mode === 'plan'` |
| `requiresPlanArtifact` | `.dsh/ulw/plans/*.md` 至少一个存在 |
| `forbidsSkills: ['ulw-execute']` | `mode !== 'execute'` |

- `plan-reviewer` / `momus` / `oracle` 额外要求：prompt 中**恰好一个** `.dsh/ulw/plans/<slug>.md`，且文件存在。
- 拒绝文案自解释，含下一步动作（`Run /ulw-plan …`）。
- `mode === 'execute'` 时一律拒绝 `plan-consultant` / `plan-reviewer`（omo 的"执行后评审结束"）。

### 5.5 `task` 工具

```
parameters:
  subagent_type?: enum[explore, librarian, plan-consultant, plan-reviewer, metis, momus, oracle]
  category?:      string   # quick | unspecified-low | unspecified-high | visual-engineering |
                           # writing | git | deep-low | deep-high | ultrabrain | architect
  description:    string   # 3-5 words
  prompt:         string
  load_skills?:   string[]
  name?:          string
  run_in_background?: boolean   # 兼容接受；不改变行为（一律内联）
```

| 情形 | 行为 |
|---|---|
| `subagent_type` | 别名展开 → `agentPreset`；`provider:'spawn'`；`maxDepth: 1` |
| `category` | `provider:'spawn'`，不传 preset → 继承父 preset（完整可写）；`mode==='plan'` 时拒绝（planner 不得派发实现者） |
| 两者都缺/都给 | 显式报错 |
| `delegationDepth >= 1` | 拒绝：`role agents cannot delegate` |
| 交付（唯一路径） | `delivery:'caller'` → `await activation.result` → 返回拼接文本；`finally` 中 `dispose()` |
| `run_in_background` | 接受该字段以兼容 omo 调用，但无论取值都内联执行（不实现后台投递） |
| 取消 | 透传 `exec.signal`；`finally` 中 `dispose()`，异常路径同样回收 |

> 同步语义成立依据：`startActivation` 的 receipt 带 `result: Promise<SubagentResult>`；`delivery==='caller'` 时 `notifySettlement` 直接 return，不重复投递。

### 5.6 `/ulw-mode` 命令

```js
ctx.commands.register({
  name: 'ulw-mode',
  description: 'Set the ulw workflow mode for this session (off | plan | execute)',
  input: { hint: 'off | plan | execute' },
  handler({ rawInput }) {
    const mode = rawInput.trim()
    if (mode !== 'off' && mode !== 'plan' && mode !== 'execute') {
      return { kind: 'error', text: 'Usage: /ulw-mode off|plan|execute' }
    }
    // 不需要自己写事件：commands 服务在 handler 之前已追加 command/run（含 args），投影折叠它
    return { kind: 'success', text: `ulw mode: ${mode}` }
  },
})
```

> `recordInput` 必须保持默认 `true`（否则 `command/run` 不带 `args`，投影读不到模式）。

### 5.7 skill 注册

```js
ctx.skills.register({
  name: 'ulw-plan',
  description: '<frontmatter 原文>',
  content: renameArtifacts(stripFrontmatter(read('skills/ulw-plan/SKILL.md'))),
  resourceBase: { kind:'directory', path: <abs skills/ulw-plan> },
  invocation: { modelInvocable: true, userInvocable: true },
})
```

- `resourceBase` 让 `<skill-root>` 以绝对路径出现。
- `renameArtifacts` 是**唯一的运行时变换**（§6.1），不对正文做其他修饰。
- 脚本文件在磁盘上已改名（要被执行，不能运行时变换）。

---

## 6. 保真策略

### 6.1 T1：产物根改名（`.omo` → `.dsh/ulw`）

逐文件登记（共 **57 处 / 7 文件**）：

| 文件 | 处数 | 处理 |
|---|---|---|
| `skills/ulw-plan/SKILL.md` | 4 | 纯文本替换 |
| `skills/ulw-plan/references/full-workflow.md` | 18 | 纯文本替换（含 review 合约 JSON 里的路径） |
| `references/intent-{clear,unclear}.md` | 0 | 不动 |
| `skills/ulw-plan/scripts/plan-templates.mjs` | 7 | 纯文本替换（含 `.dsh/ulw/evidence/`） |
| `skills/ulw-plan/scripts/scaffold-plan.mjs` | 10 | **4 处结构性手改**，其余文本替换 |
| `skills/ulw-execute/SKILL.md` | 12 | 纯文本替换 |
| `prompts/plan-reviewer.md` | 6 | 纯文本替换 |

`scaffold-plan.mjs` 的 4 处结构性手改（不能盲替换）：

1. `/(^|[/\\])\.omo([/\\]|$)/i` → `/(^|[/\\])\.dsh(?:[/\\])ulw([/\\]|$)/i`
2. `resolve(cwd, ".omo")` → `resolve(cwd, ".dsh", "ulw")`
3. `join(".omo", "drafts", …)` → `join(".dsh", "ulw", "drafts", …)`
4. `join(".omo", "plans", …)` → `join(".dsh", "ulw", "plans", …)`

> 盲替换会把正则变成 `/\.dsh/ulw/`（在 Windows 路径上失配），并把 join 变成单段 `".dsh/ulw"`。这 4 处必须手写。

**验证方法（反向替换 diff）**：对每个文本文件执行 `.dsh/ulw` → `.omo` 的反向替换，与 omo 源文件 `diff`，
除 A1/A2/A3 与这 4 处结构性手改外必须**零差异**。这比"肉眼看过"可靠。

### 6.2 追加式改动（3 处，不改原文）

| # | 文件 | 改动 |
|---|---|---|
| A1 | `skills/ulw-plan/SKILL.md` | `## Delegation` 后加 3 行 DSH 段，指向 `references/dsh-harness.md` |
| A2 | `skills/ulw-execute/SKILL.md` | Codex 节后加「DeepSeek Harness Tool Compatibility」整节（同结构 + 「本节优先」），含 `dsh:<session_id>` 前缀 |
| A3 | `skills/ulw-plan/references/dsh-harness.md` | 新增：工具对照表、`metis/momus/oracle` 别名、`category` 语义、scaffold 调用、guard 行为 |

### 6.3 其余全部逐字

4 个 role prompt 的正文（除 plan-reviewer 的 6 处路径）、3 个 reference、2 个脚本的其余部分、
plan 模板 header、审批/评审合约、`ULW-PLAN MODE ENABLED!` 契约、review 收敛合约 JSON——不动。

### 6.4 已知行为差异（写进 README + `docs/fidelity.md`）

1. `task` **一律内联**：`run_in_background` 被接受但不改变行为（本项目不实现后台投递）。
2. 无 `task_output` / `task_send` / `task_cancel`：用 `send_message` / `interrupt_agent` / 结算通知。
3. 无 continuation hook：`create_goal` 承担；P7 可补 `agent/turn-stopping`。
4. `category` 不选模型（P6 可选）。
5. plan-gate 的"本会话触碰过 plan"简化为"mode=plan 且产物存在"。
6. 新增 `/ulw-mode` 逃生口。
7. `ledger` 路径为 `.dsh/ulw/ulw-execute/ledger.jsonl`（机械改名结果；若想更短是另一个独立决策）。

---

## 7. 风险

| id | 风险 | 缓解 |
|---|---|---|
| **R1** | `agentPresets.register()` 挂载时 `@deepseek-ai/*` 行解析失败 | P1 首条验收：`agentPresets.list()` 无 `broken`；退路是改在 `cordis.patch.yml` 声明 preset |
| **R2** | 插件 import dsh 运行时包解析不到 | 零 import；普通对象定义工具；`ctx.inject` 取服务 |
| **R3** | guard 误伤（把正常写入拦掉） | 只认 `write`/`edit`；只在本会话 `mode==='plan'`；路径 containment 放行产物目录；单测覆盖 4 个边界 |
| **R4** | 用户被困在 plan 模式 | `/ulw-mode off`；拒绝文案里直接给命令 |
| **R5** | `task` 全局可见，子代理也能调 | `delegationDepth >= 1` 硬拒绝 |
| **R6** | 内联等待导致长探索阻塞当前轮 | 工具描述写明"调用会等待子代理完成"；并行的多个 `task` 仍可在同一 assistant message 内并发执行 |
| **R7** | 4 个 preset 出现在 Web 预设选择器 | `name` 加 `omo ` 前缀、`order: 100+`、README 说明 |
| **R8** | `bash` 不受 guard 约束 | 与 omo 一致（其 hook 也不管 Bash）；`write/edit` 已移除；记录在 fidelity |
| **R9** | 投影 `stateSchema` 传的是鸭子类型 `{parse}`（无 zod 可 import） | 只用 `.parse`；`apply` 自己校验合法值；升级 DSH 时复核 `stateSchema` 调用点 |
| **R10** | 改名遗漏或误伤 | 反向替换 diff + `grep -c '\.omo'` 计数为 0 的双向检查 |
| **R11** | 自定义 session 事件会被持久化读路径拒绝（未知类型且非 ignorable） | 只用已知事件：`command/run` + `user/message`；不写 `ulw/*` 事件，不 import dsh-session |

---

## 8. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** 骨架 | package/patch/lib 空壳/README | `install_bundle` → `applied`；`list_plugins` 出现 `omo` |
| **P1** 四 agent | prompts + presets + 只读工具面 | `agentPresets.list()` 无 `broken`；Web 新建会话选 `omo explore` 后，首轮行为与 EXPLORE persona 一致 |
| **P2** `task` | 内联、别名、category、取消、递归拒绝、plan-gate | `Tool.listTools` 含 `task`；真实调用同步返回；`delegationDepth` 拒绝 |
| **P3** 指令 + 改名 | 57 处改名、skills 注册、`resourceBase`、脚本可执行 | `/` 出现两条指令；`/ulw-plan` 打印 marker；`scaffold-plan.mjs` 写入 `.dsh/ulw/drafts` |
| **P4** 硬化 | projection + guard + gate + `/ulw-mode` | 单测：mode 折叠、guard 四边界、gate 三条件；实测 plan 模式写产品文件被拒、写 plan 被放行 |
| **P5** 保真 | A1/A2/A3 + 反向 diff + `fidelity.md`（含 sha256） | 反向 diff 只剩 A1/A2/A3 与 4 处结构性手改 |
| **P6** 端到端 | plan → approve → consultant → reviewer → execute → boulder/ledger（+ 可选模型路由） | 一份真实 plan 走完全链路 |
| **P7**（可选） | `agent/turn-stopping` 续跑、worktree 服务 | 与 omo 无人值守续跑对齐 |

---

## 9. 验证

```bash
# 结构
dsh --profile web --dump-config | grep -n dsh-omo
# cordis_inspect_query Config.listConfigs name=dsh-omo → active
# cordis_inspect_query Tool.listTools → 含 task
# 单元
node --test
# 改名完整性
grep -rn '\.omo' skills prompts | wc -l            # 期望 0（lib/load.js 的唯一运行时改名除外）
# 反向 diff（每个文本文件）
sed 's#\.dsh/ulw#.omo#g' skills/ulw-plan/SKILL.md | diff - .vendor/omo-pinned/src/.../SKILL.md
# 行为
#   /ulw-plan ... → ULW-PLAN MODE ENABLED!；并行 2+ task(subagent_type="explore")
#   plan 模式写 src/x.ts → 被 guard 拒绝；写 .dsh/ulw/plans/x.md → 放行
#   /ulw-mode off → 写恢复（command/run 被投影折叠）
#   /ulw-mode execute → task(subagent_type="plan-reviewer") 被 gate 拒绝
```

### 9.1 执行期修订（2026-10-22）

- Node v26.7.0 的 `--test` 不接受目录实参：门禁改为 `node --test`（全量）或 `node --test test/<file>`（单文件）。
- 本机 `/tmp` 按 shell 隔离：omo 源快照固定在工作区 `.vendor/omo-pinned/src`（commit `4c6a902`），QA 工作区固定为 `.qa-ws/`。
- `.omo` 计数门禁收窄到 `skills prompts`：`lib/load.js` 必须保留一处运行时改名 `.omo → .dsh/ulw`（Task 7 的要求），因此不能把 `lib` 计入「零命中」。

**通过的定义**：`/ulw-plan` 跑完一轮、产物在 `.dsh/ulw`、guard 双向生效、`plan-reviewer` 对真实 plan 出裁决。

---

## 10. 范围之外

ulw-loop / mass-ulw / hyperplan / Kibitzer / ultrawork 关键词；`omo-native-*` 评审器；omo 模型链；
PR/CI 生命周期自动化；把 AGENTS.md 变成权限系统。

---

## 附录：文件来源对照

| 目标 | 源 | 处理 |
|---|---|---|
| `prompts/explore.md` | `senpi-task/.../explore.ts` prompt 模板 | 逐字 |
| `prompts/librarian.md` | 同上 | 逐字；`${new Date().getFullYear()}` → `%%CURRENT_YEAR%%` |
| `prompts/plan-consultant.md` | 同上 | 逐字 |
| `prompts/plan-reviewer.md` | 同上 | 逐字 + T1（6 处） |
| `skills/ulw-plan/*` | `shared-skills/skills/ulw-plan/*` | 逐字 + T1 + A1/A3 |
| `skills/ulw-execute/SKILL.md` | `shared-skills/skills/ulw-execute/SKILL.md` | 逐字 + T1（12 处）+ A2 |
