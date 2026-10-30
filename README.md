# dsh-ulw-plan

[![CI](https://github.com/beiyanpiki/dsh-ulw-plan/actions/workflows/ci.yml/badge.svg)](https://github.com/beiyanpiki/dsh-ulw-plan/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-ulw-plan.svg)](https://www.npmjs.com/package/dsh-ulw-plan)

仓库：[beiyanpiki/dsh-ulw-plan](https://github.com/beiyanpiki/dsh-ulw-plan)。内部 bundle row id 仍为 `omo`，历史设计/保真文档里出现的 `dsh-omo` 指同一实现。

omo（[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)）的 **explore → plan → execute** 工作流，作为 **一个 DeepSeek Harness Host 插件**。

- 两个指令：`/ulw-plan`（探索、规划、产出 decision-complete 的 plan）与 `/ulw-execute`（把 plan 当成 Boulder 执行）。
- 两个角色命令：`/ulw-consult`（规划前咨询）把契约注入**当前会话**就地执行；`/ulw-review` 在增强装配可用时向 Host 协调器登记要求并接受一轮**双车道**评审（回执只表示已接受、不是完成评审）；缺能力时返回 `CAPABILITY_UNAVAILABLE`，只有无 router 的独立组合才退回会话内注入。
- 研究委托走 DSH **原生** `subagent` / `subagent_fork`：explore / librarian 是技能参考里的提示词模板（`references/research-lanes.md`），不是预设 agent。
- 一层硬门禁：规划期（`mode = plan`）拒绝 `write` / `edit` 写入产品文件，只放行 `.dsh/ulw/` 产物；`execute` 模式的产品写入由 `ulw_handoff` 的执行 lease 门禁（required 计划必须先通过双评审）。high-accuracy 评审在基础面是会话内步骤，装齐增强服务后是 Host 双评审（两条车道 + 双回执 + 有界收敛），不再是 momus/oracle 双子代理。
- 增强面默认关闭、按 **API 检测**（见「使用 → 双评审」）：评审状态在 Host storage，工作区草稿里的 OKAY 不能冒充批准。已在 DSH **0.2.1-rc.4** 验证这组 API。

## 安装

插件是**零依赖、零构建**的 ESM bundle（`package.json` + `cordis.patch.yml` + `lib/`）。

### 从 npm（分发版）

在 Web GUI 的 Plugins 页安装 `dsh-ulw-plan`，或通过 Host 的 `plugin_manager`：

```text
plugin_manager { "action": "install_bundle", "target": "dsh-ulw-plan" }
plugin_manager { "action": "set_bundle", "target": "dsh-ulw-plan", "enabled": true }
```

也可以从 tarball、GitHub 或本地目录安装：把 `target` 换成 `/绝对路径/dsh-ulw-plan-0.1.0.tgz`、`github:<owner>/dsh-ulw-plan#<ref>` 或（开发时）本仓库的检出目录。

安装后 profile 的 `package.json` 会把 `dsh-ulw-plan` 放进 `dsh.profile.bundles`，包内 `cordis.patch.yml` 的 `insert` 行把 `dsh-ulw-plan` 挂到 Host 平面。**不要手工维护这两处**：依赖/bundle 列表和 bundle 的 `insert` 行由 `plugin_manager` 管理；但 profile 的 `cordis.patch.yml` 是受支持的**用户覆盖层**，用它按 row id（`omo`）覆盖插件配置（例如下面「配置」一节的 `review` 块）。也不要在 profile 目录跑 `pnpm`。

发布到 npm / 上架插件市场 / 升级与私有分发的完整流程见 [`docs/publishing.md`](docs/publishing.md)。

## 使用

### `/ulw-plan <请求>`

在一个普通会话里键入 `/ulw-plan`，技能正文被注入，会话进入 **plan 模式**：

- 首行必须出现 `ULW-PLAN MODE ENABLED!`（omo 原文的契约）。
- 只读探索用原生 `subagent` / `subagent_fork` 派发 explorer / librarian 研究车道（模板在技能 `references/research-lanes.md`），或直接用本会话的 read / glob / grep / web 工具。
- 产物只写 `.dsh/ulw/`：`drafts/<slug>.md`、`plans/<slug>.md`。
- 产品文件写入会被 guard 拒绝，并提示退出方式。

### `/ulw-execute [plan-name]`

技能正文被注入，会话进入 **execute 模式**：按 plan 的 checkbox 用原生 `subagent` 派发实现者（tier 写进 prompt），用 Boulder / ledger 记录状态。

### `/ulw-mode off|plan|execute`

omo 没有的逃生口：显式切换本会话的 ulw 模式。投影也接受用户直接敲 `/ulw-plan` / `/ulw-execute` 的自然入口。

### `/ulw-consult <请求>` 与 `/ulw-review <plan-path>`

两条角色命令（替代 omo 的独立 agent）：`/ulw-consult` 在会话内执行；`/ulw-review` 默认走 Host 双评审（见下节），只有无 router 的独立组合才回退会话内注入。

| 命令 | 行为 |
| --- | --- |
| `/ulw-consult <请求>` | 校验请求后，把 plan-consultant 契约（`references/plan-consultant.md`）+ 请求文本作为一轮用户消息注入当前会话；`execute` 模式下拒绝 |
| `/ulw-review <plan-path>` | 校验目标（必须是存在的 `.dsh/ulw/plans/<slug>.md`，YAML 拒绝，目录约束强制）；增强装配可用时向协调器 `require` 并接受一轮双评审，返回「已接受、未完成」的回执，再用 `wait`/`status` 取两条车道的终态；能力缺失时返回 `CAPABILITY_UNAVAILABLE` 并列出缺失服务，不注入 inline 契约；`execute` 模式下拒绝 |

两条命令都通过 `agent.followup` 落成普通用户轮次（与 `/goal` 同一座 Host 桥），注入内容模型可见、会话日志可持久。`/ulw-consult` 注入 consultant 契约；`/ulw-review` 在发货入口（`lib/index.js` 注入的 review router）里不再注入 reviewer 契约，而是接受一轮 Host 双评审，并通过 followup 提示会话去 `ulw_review` `wait`/`status`。只有 `lib/commands.js` 在没有 router 的独立组合里才保留旧的 inline 契约注入；安装后的插件不会走那条审批路径。

### 双评审（enhanced，默认关闭）

装齐 Host 服务后，`ulw_review` 工具与 `/ulw-review` 共用同一个协调器：

- `ulw_review` 只有选择参数：`action` = `require|start|wait|status|cancel`，加一个 `target` 或 `roundId`；参数里没有 verdict、approved、prompt 或 session 字段。
- 两条车道（`practical` / `adversarial`）是两个独立 namespaced preset 的原生子会话，各自通过 `ulw_review_input` 分页读取同一份不可变计划快照（至多 16 KiB/页），看不到对方结论，也不能用 `read` 的截断输出替代快照。
- `require` 只登记要求；`start` 的返回是 **accepted**，不是完成；`wait`/`status` 才看得到两条车道的完整回执。只有协调器写入 `approved: true` 且 `completed: true`（两条车道都完整交付并结构化 OKAY）才算通过；缺一条、超时、源文件变化、INCONCLUSIVE 或能力缺失都不是审批。
- 评审期间 reviewer 子会话只读；计划字节在批准后仍受执行 lease 的 instruction-hash 约束（见下节）。

#### 兼容性：按 API 检测

增强评审不按版本号开关，而是检测 `subagents`、`agentPresets`、`llm`、`storage` 四个 Host 服务。缺任何一个时：基础 `/ulw-plan`、`/ulw-execute`、`/ulw-consult`、`/ulw-mode` 与 guard 照常工作；`ulw_review`、`ulw_handoff` 和 `/ulw-review` 返回 `CAPABILITY_UNAVAILABLE`，`missing` 列出缺的服务，且**不会**退回 inline 审批。

已在 **DSH 0.2.1-rc.4**（本机安装）验证这组 API。`package.json` 的 `engines.dsh` 仍声明 `>=0.2.0-rc.2`，那是**基础面**的安装下限；该版本早于这组增强 API，未验证，本文档也不声称旧下限已经具备它们。

#### 配置：默认关闭，显式授权

不写 `review`（或写 `enabled: false`）就是安全默认：不授权任何路由、零模型调用。`ulw_review` / `ulw_handoff` 仍会注册（工具面始终可见），但 `require` / `start` 以 `CAPABILITY_UNAVAILABLE` 拒绝（disabled or lacks explicit authorization），不会产生 requirement，也不会退回 inline 审批。

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
# 默认：不写 config（或显式关闭），不授权路由、零次模型调用。
- id: omo
  name: dsh-ulw-plan
  config:
    review:
      enabled: false
```

启用时必须同时给出两条固定路由和正偶数 `callBudget`；两路解析后的模型标识必须不同（同一模型换供应商不算多模型）。下面是不含任何密钥的合法示例，`test/review-package.test.mjs` 会把它交给真实解析器：

<!-- review-config:start -->
```yaml
- id: omo
  name: dsh-ulw-plan
  config:
    review:
      enabled: true
      storageBackend: json
      backend: spawn
      callBudget: 4
      lanes:
        practical:
          provider: deepseek
          model: deepseek-chat
          maxTokens: 4096
        adversarial:
          provider: anthropic
          model: claude-sonnet-4-5
          maxTokens: 4096
          reasoningEffort: high
```
<!-- review-config:end -->

- `provider` / `model` 必须能在 Host 的 llm 配置里解析；请换成本机实际注册的标识，否则 `start` 的预检会失败（`ROUTE_UNAUTHORIZED` 或 `CAPABILITY_UNAVAILABLE`）。
- 这里只写路由标识，**不写 API key**；密钥属于 Host 的 provider/credentials 配置，评审配置永远不需要它们。
- `callBudget` 是资源闸（正偶数），不是固定轮数；预算耗尽会停下来等待新的显式授权，而不是放行。
- `storageBackend` 只接受 `json`，`backend` 只接受 `spawn`；状态存 Host storage，不读工作区里的 Markdown/JSON 当作批准。
- 解析器拒绝畸形、奇数预算、两条相同模型、未知字段；写着 `enabled: true` 本身也不会自动调用模型。

**公开 GUI 的模型 allowlist 不是这个服务的配置。** Web GUI / 工具层的模型 allowlist 只约束那个 GUI 面的工具选择；它既不授权评审服务，也不会被插件读取来扩大路由。这里的授权只来自显式 `review` 配置（缺失时就是安全默认）。

#### 执行交接（`ulw_handoff`）

`execute` 模式的产品写入不由 plan 投影授权，而由 Host 执行交接 lease 门禁（`lib/guard.js` 读取 `ctx.handoff`）：

- `ulw_handoff check target=...`：校验当前计划的 required 记录与 raw digest，为当前 worker 签发可撤销 lease；普通（未要求评审）计划通过 check 后直接得到普通 lease。
- `ulw_handoff bootstrap target=...`：在固定产物路径调用现有 scaffold 函数重建草稿并重新要求评审，不靠放行 `bash`。
- `ulw_handoff bind-worktree`：只接受同一 repo 的只读 Git worktree，并复核 instruction hash，相同 basename 不能继承批准。
- 未取得 lease 前，产品 `write`/`edit`、`bash`、`run_code`、实现委托（`subagent`/`subagent_fork`）与未知副作用工具被拒；只读工具（含 web）、`schedule_*`/`job_*`/`list_agents`/`send_message`/`interrupt_agent`/`present`、计划/草稿写入、review/handoff/goal/todo/提问工具可用。取得 lease 后，计划字节只允许合法任务行的 `[ ]/[x]/[~]` 状态位变化；instruction 字节一变就撤销 lease 并要求重审。

## 产物

```text
.dsh/ulw/drafts/<slug>.md
.dsh/ulw/plans/<slug>.md
.dsh/ulw/boulder.json
.dsh/ulw/ulw-execute/ledger.jsonl
```

路径与 omo 的 `.omo/` 同构，只做了目录改名（见 `docs/fidelity.md`）。`.dsh/ulw/evidence/` 建议不进版本库。

## 与 omo 的差异

完整清单在 `docs/fidelity.md` 的「已知行为差异」与「DSH-native 重构」。要点：

1. 没有独立角色 agent：`/ulw-consult` 仍是会话内命令；`/ulw-review` 在无 router 的独立组合里是会话内契约，在增强装配可用时是 Host 协调器发起的双车道原生评审（固定 namespaced preset，不是 momus/oracle alias，也不是 `task` 子代理）。explore / librarian 是研究车道提示词模板，经原生 `subagent` / `subagent_fork` 派发。
2. 没有 `task` 工具：实现者派发用原生 `subagent`，`category` 只是 prompt 词汇（不选模型、不是参数）。
3. high-accuracy 评审：基础面是 plan 工作流的会话内步骤（单车道 + 有界收敛）；增强装配可用时由 Host 双评审承担（两条车道 + 双回执 + 有界收敛），不再是 momus/oracle 双子代理。
4. 没有 continuation hook；用 `create_goal` 承担续跑。
5. 旧 plan-gate 的三条件简化为命令/工具校验：`/ulw-review` 校验唯一目标路径并在 `execute` 模式拒绝；`execute` 模式的产品写入由 `ulw_handoff` 的执行 lease 门禁（required 计划需先通过双评审）。
6. 新增 `/ulw-mode`。
7. guard 在 **plan 模式**不管 `bash`（与 omo 的 prometheus-md-only 一致，否则 `scaffold-plan.mjs` 无法产出文件）；**execute 模式**的 `bash` 由 `ulw_handoff` 的执行 lease 门禁，未取得 lease 前拒绝。
8. 模型用 `skill` 工具自行加载 `ulw-plan` 不会切换模式；进入 plan 模式请用 `/ulw-plan` 或 `/ulw-mode plan`。

## 安装后手工检查清单

1. `dsh --profile web --dump-config | grep dsh-ulw-plan` —— 至少一行。
2. `cordis_inspect_query Config.listConfigs name=dsh-ulw-plan` —— 出现该行且为 active。
3. `cordis_inspect_query Tool.listTools` —— 不再含 `task`（委托走原生 `subagent`）。
4. `skills/list` —— 含 `ulw-plan`、`ulw-execute`，且 `invocation.userInvocable === true`。
5. Web 输入 `/` —— 菜单里能看到 `/ulw-plan`、`/ulw-execute`、`/ulw-consult`、`/ulw-review`、`/ulw-mode`。
6. 会话里敲 `/ulw-review <存在的 plan 路径>` —— 回执明确写着已接受但**不是**完成评审；随后 `ulw_review` `wait`/`status` 能看到两条 lane 的终态。缺增强服务时应看到 `CAPABILITY_UNAVAILABLE` 与 missing 列表，而不是 injected contract。
7. `execute` 会话里先 `ulw_handoff check target=<plan>` 拿到 lease，再改产品文件；未 check 前产品写入必须被拒，改计划 instruction 后 lease 失效。

## 开发

```bash
node --test   # Node 26 discovers test/*.test.mjs; a bare directory argument is rejected
for file in lib/*.js skills/*/scripts/*.mjs qa/*.mjs test/*.test.mjs; do node --check "$file"; done
grep -rn '\.omo' skills | wc -l     # 期望 0；lib 侧只有 load.js 的运行时改名与 paths.js 的注释提及
npm pack --dry-run --json            # test/review-package.test.mjs 断言同一份清单
```

`docs/fidelity.md` 记录 11 个移植文件的 sha256、57 处 `.omo → .dsh/ulw` 改名、4 处结构性手改、A1/A2/A3 追加，以及 A4/A5 的现行形态与已知差异。

## 发布

`dsh-ulw-plan` 由 GitHub Actions 在 `v*` tag 上 stage 到 npm，维护者用 2FA 批准后上线；Trusted Publisher / bypass token 的完全自动发布路径见 [`docs/publishing.md`](docs/publishing.md)。
