# dsh-omo-plugin - Work Plan

## TL;DR (For humans)

**Who this is for and what changes for them:** 喜欢 omo「先探索、再规划、后执行」工作方式的 DSH 用户。今天他们在这台 harness 里没有这套流程；之后他们会得到两个斜杠指令和四个只读助手，并且规划期间**真的**改不动产品代码。

**What you'll get:** 一个可安装的 DSH 插件：两个斜杠指令、四个只读助手（探索、资料检索、规划顾问、规划评审）、一个统一的委派工具，外加一层把「规划期不许实现」从口号变成拒绝理由的门禁。

**Why this approach:** 一个 Host 级插件、一个安装行——工具、技能、助手的注册都对所有会话可见，不需要接管任何出厂预设；omo 的提示词逐字保留，只做一次机械的产物目录改名和两段追加说明。

**What it will NOT do:** 不做 omo 的 ulw-loop / mass-ulw / 模型链 / PR 自动化；不做后台委派（一律内联等待结果）；不改写 omo 的提示词措辞；不接管出厂预设、不引入运行时依赖、不写自定义会话事件类型。

**Effort:** Medium
**Risk:** Medium - 唯一未被证实的是「插件注册的预设能否解析出厂插件包」；失败则退回补丁声明并多一个重建步骤。
**Decisions to sanity-check:** ①规划期用硬门禁拦住产品文件写入；②产物放进独立目录，不与现有工具抢项目根；③委派一律内联等待（不实现后台）；④保留一个统一的委派工具，不复用出厂工具；⑤新增一个模式切换指令作为逃生口。

> **Status（2026-10-23）：已执行并验证完成。** 8 个 todo 与 F1–F4 全部完成，4 个最终验证器全部 APPROVE。交付：Host bundle `dsh-omo`（已装入 `web` profile）、逐字 prompt/skill、`ulwMode` 投影、4 个只读 preset、内联 `task` + plan-gate、`/ulw-mode`、规划期写入门禁。验证：53 个单测通过、11 个移植文件逐字节保真、headless 真机跑通 `/ulw-plan`、任务委派、plan-gate 双向与 guard 双向。执行期修订与已知限制见 `README.md` 与 `docs/fidelity.md`。

后续使用：从 `/ulw-plan <请求>` 开始，或用 `/ulw-mode off|plan|execute` 切换本会话模式。

---

> TL;DR (machine): Medium / Medium — 8 todos over 2 waves: one Host-plane bundle (4 presets, 2 skills, 1 inline task tool, 1 command, 1 projection, 1 guard, gate inside task) with verbatim omo prompts under `.dsh/ulw`.

## Scope

### Affected user and ideal state

**Affected user:** 三类人共用同一结果——(1) 在 DSH 里写代码/运维的人，今天要么自己手搓「先探索再规划」的流程，要么把 omo 的习惯带不过来；(2) 消费这些指令的模型，今天拿到的是空白的工具面；(3) 未来的维护者，今天无法判断哪些字节来自 omo、哪些是本地改动。

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | 键入 `/ulw-plan <请求>` 后，会话首行出现 `ULW-PLAN MODE ENABLED!`，随后只做只读探索与规划，不写任何产品代码 | 这是 omo 规划契约的入口；没有它就只是「一个叫 planning 的提示词」 |
| IS-2 | 规划期间写 `src/**` 被拒绝并提示如何退出；写 `.dsh/ulw/**` 被放行 | 纪律必须可执行，否则模型会在「顺手修一下」里破坏规划边界 |
| IS-3 | `task(subagent_type="explore"|"librarian")` 返回结构化的只读研究结果；`plan-consultant`/`plan-reviewer` 及其别名只在规划期可拉起 | 四个助手的分工与门禁是 omo 的核心语义 |
| IS-4 | `/ulw-execute` 之后，`task(category="quick")` 能派发实现者并拿到结果 | 执行阶段需要「完整能力 worker」通道 |
| IS-5 | 所有产物落在 `.dsh/ulw/{drafts,plans,boulder.json,ulw-execute/ledger.jsonl}`，结构与 omo 同构 | 可审计、可复用、不污染项目根 |
| IS-6 | 维护者把任一移植文件反向替换 `.dsh/ulw`→`.omo` 后与 omo 源文件 diff，只剩登记过的改动；sha256 清单可直接比对 | 保真是可验证的，不是口头承诺 |

| Row | Statement | Reason |
| --- | --- | --- |
| GAP-1 | DSH 侧没有任何载体：无 bundle、无助手、无指令、无委派工具 | IS-1/IS-3/IS-4 全部落空 |
| GAP-2 | DSH 没有规划期写入门禁（内置 plan-mode 明确"every tool remains available"，挡不住写产物） | IS-2 落空 |
| GAP-3 | 会话模式无法用自定义事件记录（持久化拒绝未知非 ignorable 类型） | 模式无从判定 |
| GAP-4 | omo 写死 `.omo/`，与 opencode/omo 自身的产物目录冲突 | IS-5 落空 |
| GAP-5 | 没有任何机制证明「迁移没有偷偷改原文」 | IS-6 落空 |
| GAP-6 | omo 的三条 plan-gate 条件未被实现 | IS-3 的「仅规划期可拉起」落空 |

### Must have

1. 一个 Host 平面 bundle（`package.json` + `cordis.patch.yml` + `lib/index.js`），无运行时依赖、无构建步骤。
2. 四个 role preset（`explore`/`librarian`/`plan-consultant`/`plan-reviewer`），persona 逐字取自 omo，写工具面关闭。
3. 一个 `task` 工具：`subagent_type`（含 `metis`/`momus`/`oracle` 别名）与 `category` 二选一，**内联返回结果**，递归硬拒绝，plan-gate 内建。
4. 两个 user-invocable skill（`ulw-plan`/`ulw-execute`），正文逐字 + 一处机械改名 + 三段追加说明。
5. 一个 `ulwMode` 投影、一个写入门禁。
6. `/ulw-mode` 逃生口。
7. 单测（纯逻辑）+ 反向 diff 保真校验 + sha256 清单。

### Must NOT have (guardrails, anti-slop, scope boundaries)

- **不接管 shipped preset**：不改 `preset-standard`/`preset-ptc`，不整体复制它们的 plugin 列表。
- **不 import 任何 `@deepseek-ai/*` 运行时包**（第二份拷贝会打断 `appendPluginRecord` 的静态钩子）。
- **不写自定义 session 事件类型**：只用 `command/run` 与 `user/message`。
- **不实现后台委派**：`task` 一律内联等待；`run_in_background` 仅为兼容接受、不改变行为。
- **不把 guard 扩展到 `bash`**：与 omo 的 prometheus-md-only 一致（其 hook 也不管 Bash），否则 `scaffold-plan.mjs` 跑不了。
- **不改写 omo 措辞**：除 T1 改名、A1/A2 追加段、A3 新文件外，一个标点都不动；尤其不要"顺手优化"标题层级、空行、emoji。
- **不做**：ulw-loop、mass-ulw、hyperplan、Kibitzer、ultrawork 关键词、`omo-native-*` 评审器、模型链、PR/CI 生命周期、continuation hook、安装自检脚本（改为 README 里的手工检查清单）。
- **不把测试写成实现镜像**：禁止断言内部字段名、调用次数、私有函数名。

## Verification strategy

> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after**，仅覆盖纯逻辑（路径 containment、gate 条件、投影折叠、guard 判定）；工具/技能/门禁的**行为**用真实会话 QA，不写 mock 断言。
- 框架：`node --test`（零依赖，Node 内置）。
- Evidence: `<attemptDir>/task-<N>-dsh-omo-plugin.<ext>`，其中 `attemptDir = .dsh/ulw/evidence/<session>/<goalId>/a<attempt>`（不在 ulw-loop 内时退化为 `.dsh/ulw/evidence/`）。
- 门禁命令（每个 todo 至少跑一次）：`node --test`（Node 26 不接受目录实参；`node --test test/<file>` 用于单文件）、`grep -rn '\.omo' skills prompts | wc -l`（期望 0；`lib/load.js` 的运行时改名是唯一登记的允许命中）、`node --check` 所有改动过的 `.js`/`.mjs`。
- 安装后手工清单（写进 README，替代独立的 doctor 脚本）：`dsh --profile web --dump-config | grep dsh-omo`、`Config.listConfigs name=dsh-omo`、`Tool.listTools` 含 `task`、`skills/list` 含两条、`agentPresets.list()` 无 `broken`、`/` 菜单可见两条指令。

## Execution strategy

> **执行期修订（2026-10-22）**：① Node v26.7.0 的 `--test` 不接受目录实参，门禁改为 `node --test`（全量）与 `node --test test/<file>`（单文件）；② 本机 `/tmp` 按 shell 隔离，omo 源快照固定在工作区 `.vendor/omo-pinned/src`（commit `4c6a902`），QA 工作区固定为 `.qa-ws/`；③ `.omo` 计数门禁收窄到 `skills prompts`，`lib/load.js` 保留唯一一处运行时改名。三条均由真实执行发现，证据见 `.dsh/ulw/evidence/.../a1/task-3-dsh-omo-plugin.log` 与 `task-6-reviewer-live.jsonl`。

### Parallel execution waves

> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- **Wave 1 — 地基（4 路并行）**：bundle 骨架、prompt 移植、skill 移植 + 改名 + 保真校验、模式投影。
- **Wave 2 — 能力面（4 路并行）**：四个 preset、`task` + plan-gate、skill 注册 + 逃生口、写入门禁。
- **Final verification wave**：F1–F4 全并行，全部 APPROVE 才算完成。

### Dependency matrix

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. Bundle 骨架 | — | 5,6,7,8 | 2,3,4 |
| 2. Prompt 移植 | — | 5 | 1,3,4 |
| 3. Skill 移植 + 改名 + 保真 | — | 7 | 1,2,4 |
| 4. 模式投影 | — | 6,8 | 1,2,3 |
| 5. 四个 preset | 1,2 | — | 6,7,8 |
| 6. `task` + plan-gate | 1,4 | — | 5,7,8 |
| 7. Skill 注册 + `/ulw-mode` | 1,3 | — | 5,6,8 |
| 8. 写入门禁 | 1,4 | — | 5,6,7 |

## Todos

> Implementation + Test = ONE todo. Never separate.

- [x] 1. 建 bundle 骨架并装进 profile
  What to do / Must NOT do: 写 `package.json`（`name: dsh-omo`、`type: module`、`main: ./lib/index.js`、`exports` 含 `.` 与 `./package.json`、`dsh.bundle.patch: ./cordis.patch.yml`、`engines.dsh: ">=0.2.0-rc.2"`、`files` 白名单）；写 `cordis.patch.yml`（`- insert: [{ id: omo, name: dsh-omo }]`）；写最小 `lib/index.js`（`name='dsh-omo'`、`inject=['tools']`、空 `apply`）；写 README（安装、两条指令、四个助手、`.dsh/ulw` 产物、**手工检查清单** 6 条）。Must NOT：手改 profile 的 `package.json`/`cordis.patch.yml`、在 profile 目录跑 pnpm、把文件写到 `$DSH_HOME`。
  Closes: GAP-1
  Parallelization: Wave 1 | Blocked by: 无 | Blocks: 5,6,7,8
  References (executor has NO interview context - be exhaustive): `docs/migration-plan.md` §4（仓库布局）、§5.1（入口形状）、§7 R2（零依赖）、§9（验证清单）；最小 bundle 范例 `/home/miku/.dsh/profiles/web/node_modules/dsh-context/{package.json,cordis.patch.yml}`；当前 profile `/home/miku/.dsh/profiles/web/{package.json,cordis.patch.yml}`；bundle 字段规范见 `@deepseek-ai/dsh-agent-preset` skill `references/host-plugin.md`。
  Acceptance criteria (agent-executable): `plugin_manager { action: install_bundle, target: /home/miku/dsh-omo }` 返回 `application: applied`；`plugin_manager { action: list_plugins }` 出现 `omo` 行且 `enabled: true`；`dsh --profile web --dump-config | grep -c "dsh-omo"` ≥ 1。
  QA scenarios (name the exact tool + invocation): happy = 执行上述 install 后 `cordis_inspect_query Config.listConfigs name=dsh-omo` 返回该行；failure = 临时把 `main` 指向不存在的 `lib/nope.js`，重装后 `list_plugins` 该行报加载失败，恢复后重装成功。Evidence `<attemptDir>/task-1-dsh-omo-plugin.txt`。
  Commit: Y | feat(bundle): add dsh-omo bundle skeleton
  Recommended task executor category: `unspecified-low` — 配置文件为主，机械但字段必须准确。

- [x] 2. 逐字移植四个 role prompt
  What to do / Must NOT do: 从 omo 源文件抽出 prompt 模板字面量正文，落到 `prompts/{explore,librarian,plan-consultant,plan-reviewer}.md`；`librarian` 里的 `${new Date().getFullYear()}` 换成 `%%CURRENT_YEAR%%`（运行时替换）；`plan-reviewer` 的 **6 处** `.omo` 按 T1 改成 `.dsh/ulw`（另外三个 prompt 为 0 处）。Must NOT：重排空行、改标题层级、修 typo、去掉 `<analysis>`/`<results>` 结构、翻译。
  Closes: GAP-1
  Parallelization: Wave 1 | Blocked by: 无 | Blocks: 5
  References (executor has NO interview context - be exhaustive): `.vendor/omo-pinned/src/packages/senpi-task/src/agents/builtin/explore.ts:11-87`、`librarian.ts:11-74`、`plan-consultant.ts:10-273`、`plan-reviewer.ts:10-200`（每个文件里 `prompt: \`…\`` 的模板字面量，正文从行首开始，直接复制即可）；若 `.vendor/omo-pinned/src` 不存在，重新下载 `https://codeload.github.com/code-yeongyu/oh-my-openagent/tar.gz/4c6a902` 到工作区 `.vendor/omo-pinned/src`（不要用 `/tmp`：本机 `/tmp` 按 shell 隔离）；差异策略见 `docs/migration-plan.md` 附录。
  Acceptance criteria (agent-executable): 四个文件存在且非空；`grep -rc '\${' prompts/*.md` 全为 0；`grep -rn '\.omo' prompts | wc -l` = 0；每个文件 sha256 记入 `<attemptDir>/task-2-dsh-omo-plugin.sha256`；用一个一次性脚本从 omo 源重新抽取并 `diff`，除 `%%CURRENT_YEAR%%` 与 plan-reviewer 的 6 处路径外零差异。
  QA scenarios (name the exact tool + invocation): happy = `diff <(extract explore.ts) prompts/explore.md` 空；failure = 故意把 plan-reviewer 的一处 `.dsh/ulw` 改回 `.omo`，同一 diff 只多出那一行（证明 T1 的允许列表是精确的），随后修正。Evidence `<attemptDir>/task-2-dsh-omo-plugin.diff`。
  Commit: Y | feat(prompts): vendor omo role prompts verbatim
  Recommended task executor category: `unspecified-low` — 纯搬运，但抽取脚本要能证明逐字。

- [x] 3. 移植两个 skill，执行 T1 改名与 A1/A2/A3 追加，并固化保真校验
  What to do / Must NOT do: 复制 `ulw-plan/{SKILL.md,references/{intent-clear,intent-unclear,full-workflow}.md,scripts/{scaffold-plan,plan-templates}.mjs}` 与 `ulw-execute/SKILL.md`；按 57 处清单把 `.omo` 改为 `.dsh/ulw`；`scaffold-plan.mjs` 有 **4 处结构性手改**（正则 `/\.dsh(?:[/\\])ulw([/\\]|$)/i`、`resolve(cwd,".dsh","ulw")`、两处 `join(".dsh","ulw",…)`）；新增 `references/dsh-harness.md`；追加 A1（SKILL.md 3 行指针）与 A2（ulw-execute 的「DeepSeek Harness Tool Compatibility」节）；写 `docs/fidelity.md`（源 commit `4c6a902`、11 个移植文件的 sha256、T1 的 57 处与 4 处结构手改、A1/A2/A3 全文、已知行为差异）。Must NOT：动 `intent-clear.md`/`intent-unclear.md`、重写 plan 模板 header、删 review 合约 JSON、把改名做成盲目 sed、另建独立的保真测试工程。
  Closes: GAP-4, GAP-5
  Parallelization: Wave 1 | Blocked by: 无 | Blocks: 7
  References (executor has NO interview context - be exhaustive): `.vendor/omo-pinned/src/packages/shared-skills/skills/ulw-plan/{SKILL.md:1-98,references/full-workflow.md:1-256,scripts/scaffold-plan.mjs:1-187,scripts/plan-templates.mjs:1-180}`、`.vendor/omo-pinned/src/packages/shared-skills/skills/ulw-execute/SKILL.md:1-246`；逐文件处数表与 A1-A3 规格见 `docs/migration-plan.md` §6；`scaffold-plan.mjs:67,109,117,160,163` 是 4 处结构性手改的位置。
  Acceptance criteria (agent-executable): `grep -rn '\.omo' skills | wc -l` = 0；`node --check` 两个脚本通过；`cd .qa-ws/demo && node /home/miku/dsh-omo/skills/ulw-plan/scripts/scaffold-plan.mjs demo --draft-only` 生成 `.dsh/ulw/drafts/demo.md` 且首行为 `---`；对 11 个文件逐个跑反向替换 diff，输出的差异行只落在 A1/A2/A3 与 4 处结构手改；`docs/fidelity.md` 的 sha256 行数为 11 且与文件一致。
  QA scenarios (name the exact tool + invocation): happy = 上述 scaffold 在临时工作区生成 draft，且反向 diff 只报允许列表；failure = 在已有非 ulw 同名文件（`echo junk > .dsh/ulw/drafts/demo.md`）上重跑，必须以 `refused:` 退出（非零），证明写边界仍在。Evidence `<attemptDir>/task-3-dsh-omo-plugin.log`。
  Commit: Y | feat(skills): port ulw-plan and ulw-execute with .dsh/ulw artifact root
  Recommended task executor category: `deep-low` — 57 处机械改名 + 4 处结构手改，错一处就静默坏掉。

- [x] 4. 实现 `ulwMode` 会话投影
  What to do / Must NOT do: 写 `lib/projection.js`，用 `ctx.sessionProjections.register({key:'ulwMode',stateVersion:1,stateSchema:{parse:v=>…},init,apply})`；`apply` 只折叠两类**已知**事件：`command/run`（`name==='ulw-mode'`，取 `data.args` 的 `off|plan|execute`）与 `user/message`（`source.kind==='skill-invocation'`，`name` 为 `ulw-plan`/`ulw-execute`）；未命中返回**同一 state 引用**。Must NOT：写自定义事件类型、在 `apply` 里做 IO/异步、用 zod。
  Closes: GAP-3
  Parallelization: Wave 1 | Blocked by: 无 | Blocks: 6,8
  References (executor has NO interview context - be exhaustive): `docs/migration-plan.md` §5.2（含"为什么不用自定义事件"的取证）、§7 R9/R11；投影契约 `…/dsh-session-projection/lib/types/index.d.ts:26-60`（纯同步、同引用、`stateSchema` 只用 `.parse`）；`command/run` 载荷 `…/dsh-commands/lib/index.js:334-341`（`{commandId,name,args,source}`，`recordInput` 默认 true）；skill 注入来源 `…/dsh-tool-skill/lib/index.js:901-918`（`source:{kind:'skill-invocation',name,form:'instructions'}`）。
  Acceptance criteria (agent-executable): `node --test test/projection.test.mjs` 通过；用例覆盖：`command/run ulw-mode=off` → `{mode:'off'}`；`ulw-plan` 调用 → `plan`；`ulw-execute` 调用 → `execute`；无关事件 → `Object.is(next,prev) === true`；非法 args → 不变。
  QA scenarios (name the exact tool + invocation): happy = `node --test test/projection.test.mjs`；failure = 喂一个 `command/run` 但 `data.args='bogus'`，断言 mode 未变（证明不会把垃圾写进状态）。Evidence `<attemptDir>/task-4-dsh-omo-plugin.txt`。
  Commit: Y | feat(mode): track ulw mode in a session projection
  Recommended task executor category: `deep-low` — 契约细节多（纯函数、同引用、只用已知事件）。

- [x] 5. 注册四个只读 role preset
  What to do / Must NOT do: 写 `lib/presets.js`，为 `explore`/`librarian`/`plan-consultant`/`plan-reviewer` 各构造 `PresetDefinition`：`persona.prefix` 取 `prompts/*.md`（librarian 先替换 `%%CURRENT_YEAR%%`）；`agent-instructions`；`tool-fs` 配 `{read:true,readImage:false,write:false,edit:false}`；`tool-fs-search`；`tool-bash`（`process.platform==='win32'` 时 `disabled:true`）；librarian 额外 `tool-web {fetch:true}`。`name` 统一 `omo <role>`、`order:100+`。Must NOT：挂 `tool-skill`、给 role 挂写工具、注册时静默吞错。
  Closes: GAP-1
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: —
  References (executor has NO interview context - be exhaustive): `docs/migration-plan.md` §5.2（preset 形状）、§3.1（工具面表）、§7 R1/R7；`PresetDefinition` = `…/dsh-agent-preset-registry/lib/types/definition.d.ts:1-12`；`dsh-tool-fs` 开关 `…/dsh-tool-fs/lib/index.js:1194-1202`；出厂写法参照 `…/dsh-web-app/presets/standard.patch.yml:1-40`；`dsh-persona` 语义见其 README「Mount it inside a preset composition」。
  Acceptance criteria (agent-executable): 宿主内查询 `agentPresets.list()` 返回 4 项且均无 `broken` 字段；`grep -c "tool-skill" lib/presets.js` = 0；`grep -c "write: false" lib/presets.js` ≥ 1。
  QA scenarios (name the exact tool + invocation): happy = Web 新建会话选 `omo explore`，首轮回复按 EXPLORE persona 提问（不是通用编码助手口吻）；failure = 临时把某个 preset 的 `tool-fs-search` 写成不存在的包名，`agentPresets.list()` 该 preset 出现 `broken`，恢复后消失。Evidence `<attemptDir>/task-5-dsh-omo-plugin.txt`。
  Commit: Y | feat(presets): add omo read-only role agents
  Recommended task executor category: `unspecified-high` — 4 个 preset + 工具面组合，字段错就 broken。

- [x] 6. 实现内联 `task` 工具（含 plan-gate）
  What to do / Must NOT do: 写 `lib/paths.js`（产物根 `.dsh/ulw`、`isUnderArtifactRoot` containment、跨平台 join）、`lib/gate.js`（三条件）与 `lib/task-tool.js`：schema 含 `subagent_type`（enum 7 项，含 `metis`/`momus`/`oracle`）、`category`、`description`、`prompt`、`load_skills`、`name`、`run_in_background`（**兼容接受、不改变行为**）；别名展开到 preset id；`category` 不传 preset；`delegationDepth>=1` 硬拒绝；一律 `delivery:'caller'` + `await activation.result` + `finally dispose()`，错误路径也回收；gate 在拉起前判定：`plan-consultant`/`metis` 需 `mode==='plan'` 且有 draft/plan 产物，`plan-reviewer`/`momus`/`oracle` 额外要求 prompt 中**恰好一个** `.dsh/ulw/plans/<slug>.md` 且文件存在，`mode==='execute'` 时二者一律拒绝，`category` 在 `mode==='plan'` 时拒绝。Must NOT：用 `defineTool` 或 import dsh 包（用普通对象 `{name,description,parameters,output:{schema,render},execute}`）、实现后台投递、把 `isConcurrencySafe` 设为 false、让 gate 变成异步。
  Closes: GAP-1, GAP-6
  Parallelization: Wave 2 | Blocked by: 1,4 | Blocks: —
  References (executor has NO interview context - be exhaustive): `docs/migration-plan.md` §5.3/§5.4/§5.5、§3.1；`startActivation` `…/dsh-subagent/lib/index.js:3036-3047`；本地启动与 `delivery==='caller'` 分支 `…/dsh-subagent/lib/index.js:1389-1490`；结算与通告 `…/dsh-subagent/lib/index.js:2036-2060`；`SessionHeader.delegationDepth` `…/dsh-session/lib/types/types.d.ts:83-95`；工具定义形状 `…/dsh-tools/lib/types/index.d.ts`（`ToolDefinition`/`ToolExecutionInput`）；omo 的三条件 `.vendor/omo-pinned/src/packages/senpi-task/src/agents/invocation-guard.ts:1-80`；reviewer 单路径契约见 `prompts/plan-reviewer.md` 的 "CRITICAL FIRST RULE" 段。
  Acceptance criteria (agent-executable): `cordis_inspect_query Tool.listTools` 含 `task`；`node --test test/task-tool.test.mjs test/gate.test.mjs` 通过（别名映射、缺参/双参报错、depth=1 拒绝、gate 三条件 × 产物存在/缺失、execute 拒绝、category-in-plan 拒绝、explore 放行）；真实会话 `task(subagent_type="explore", prompt="列出 lib/ 下文件")` 返回文件清单。
  QA scenarios (name the exact tool + invocation): happy = 上述真实调用返回文本；failure = `/ulw-execute` 后 `task(subagent_type="plan-reviewer", …)` 立即返回 gate 错误而非拉起子代理。Evidence `<attemptDir>/task-6-dsh-omo-plugin.txt`。
  Commit: Y | feat(task): add inline omo-compatible delegation with plan gate
  Recommended task executor category: `deep-high` — 生命周期、回收、门禁接线，错了会泄漏子会话或放错行。

- [x] 7. 注册两个 skill 与 `/ulw-mode`
  What to do / Must NOT do: 写 `lib/skills.js`（读 `SKILL.md` → 剥 frontmatter → 用 frontmatter 的 `name`/`description` 注册；`resourceBase:{kind:'directory',path}`；`invocation:{modelInvocable:true,userInvocable:true}`；内容里执行与 T1 一致的运行时改名，防止漏改）与 `lib/commands.js`（`ulw-mode`：校验 `off|plan|execute`，返回成功/用法文案，**不自己写事件**；`recordInput` 保持默认）。Must NOT：注册同名 command 覆盖两个 skill、给 command 设 `recordInput:false`、缓存 skill 正文到模块级单例。
  Closes: GAP-1
  Parallelization: Wave 2 | Blocked by: 1,3 | Blocks: —
  References (executor has NO interview context - be exhaustive): `docs/migration-plan.md` §5.6、§5.7、§3.2；`SkillRegistration` 与 `renderSkillContent` `…/dsh-skill/lib/index.js:57-80` 与 `…/dsh-skill/lib/types/index.d.ts:68-90`；`/name` 手势 `…/dsh-tool-skill/lib/index.js:1101`；命令生命周期 `…/dsh-commands/lib/index.js:330-350`；`command/run` 的 `args` 字段名（投影依赖它）。
  Acceptance criteria (agent-executable): `skills/list` 含 `ulw-plan`、`ulw-execute` 且 `invocation.userInvocable===true`；Web 输入 `/` 能看到两项；`/ulw-mode bogus` 返回 `Usage: /ulw-mode off|plan|execute`；随后 `session` 里有 `command/run` 且 `data.args` 为 `bogus`。
  QA scenarios (name the exact tool + invocation): happy = `/ulw-plan 给 /login 加 5/min 限流`，首行 `ULW-PLAN MODE ENABLED!`；failure = `/ulw-mode bogus` 后 `task(subagent_type="plan-reviewer")` 仍被拒（模式没被垃圾覆盖）。Evidence `<attemptDir>/task-7-dsh-omo-plugin.txt`。
  Commit: Y | feat(skills): register ulw-plan and ulw-execute as user-invocable skills
  Recommended task executor category: `unspecified-high` — 注册面 + 内容变换，细节多。

- [x] 8. 实现规划期写入门禁
  What to do / Must NOT do: 写 `lib/guard.js`，`ctx.tools.guard(exec => …)`：无 `exec.agent` 放行；`stateOf(session,'ulwMode').mode !== 'plan'` 放行；工具名不在 `{write,edit}` 放行；`file_path` 解析后落在产物根内放行；否则返回一句含退出指引的拒绝理由（提到 `/ulw-mode execute` 与 `/ulw-mode off`）。Must NOT：拦 `bash`、拦 `todo_write`、拦 `read`/`grep`/`glob`、按字符串前缀判断路径（必须 `resolve` + `relative` containment）。
  Closes: GAP-2
  Parallelization: Wave 2 | Blocked by: 1,4 | Blocks: —
  References (executor has NO interview context - be exhaustive): `docs/migration-plan.md` §5.3、§7 R3/R4/R8；`ToolGuard` 契约 `…/dsh-tools/lib/types/index.d.ts:508-522`（返回字符串即拒绝）；`tools.guard` 语义 `…/dsh-tools/lib/index.js:3017` 起；`write`/`edit` 的参数名 `file_path` 见 `…/dsh-tool-fs/lib/index.js:548,689`；omo 的写边界参照 `scaffold-plan.mjs:59-74`（含符号链接拒绝思路）。
  Acceptance criteria (agent-executable): `node --test test/guard.test.mjs` 覆盖 6 个用例：plan+write 产品→拒绝；plan+edit 产品→拒绝；plan+write `.dsh/ulw/plans/x.md`→放行；execute+write 产品→放行；off+write 产品→放行；plan+bash→放行。
  QA scenarios (name the exact tool + invocation): happy = 真实会话 `/ulw-plan` 后 `write src/tmp.ts` 被拒且理由含 `/ulw-mode`；failure = 同一会话写 `.dsh/ulw/plans/probe.md` 成功（证明没有一刀切）。Evidence `<attemptDir>/task-8-dsh-omo-plugin.txt`。
  Commit: Y | feat(guard): block product writes during planning
  Recommended task executor category: `deep-low` — 路径 containment 与边界条件是静默出错的高发区。

## Final verification wave

> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.

- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Ideal-state fidelity

## Commit strategy

- 每个 todo 在其 Acceptance + QA 均通过后单独提交，Conventional Commits；**不**把多个 todo 合并成一个提交。
- 提交信息必须点名范围（`bundle|prompts|skills|presets|task|guard|mode`），便于 `git log --oneline` 直接看出保真层次。
- `docs/migration-plan.md` 与 `docs/fidelity.md` 是**设计/保真文档**（入库）；`.dsh/ulw/plans/**` 是**执行产物**（不强制入库，与 omo 的 `.omo/` 习惯一致；要入库就单独一个 `chore(plan): track the implementation plan`）。
- `.gitignore` 至少排除 `.dsh/ulw/evidence/`；`plans/` 是否入库由用户决定。
- 禁止提交：`node_modules/`、临时 QA 目录、`.dsh/ulw/evidence/**`。

## Success criteria

> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.

| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 3, 7 | `/ulw-plan` 首行 marker + 只读探索 | `<attemptDir>/task-7-dsh-omo-plugin.txt` |
| IS-2 | 4, 8 | plan 模式写产品被拒 / 写产物放行 | `<attemptDir>/task-8-dsh-omo-plugin.txt` |
| IS-3 | 5, 6 | 四助手 + 别名 + plan-gate 双向 | `<attemptDir>/task-6-dsh-omo-plugin.txt` + `task-6-reviewer-live-2.jsonl` |
| IS-4 | 6 | execute 模式下 `task(category=…)` 派发并拿到结果 | `<attemptDir>/task-6-category-execute.jsonl` |
| IS-5 | 3 | 产物路径与结构 + 反向 diff | `<attemptDir>/task-3-dsh-omo-plugin.log` |
| IS-6 | 3 | 反向替换后 diff 只剩登记改动 + sha256 清单 | `<attemptDir>/task-3-dsh-omo-plugin.log` |
