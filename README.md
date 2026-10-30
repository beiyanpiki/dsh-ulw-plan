# dsh-ulw-plan

[![CI](https://github.com/beiyanpiki/dsh-ulw-plan/actions/workflows/ci.yml/badge.svg)](https://github.com/beiyanpiki/dsh-ulw-plan/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-ulw-plan.svg)](https://www.npmjs.com/package/dsh-ulw-plan)

仓库：[beiyanpiki/dsh-ulw-plan](https://github.com/beiyanpiki/dsh-ulw-plan)。内部 bundle row id 仍为 `omo`，历史设计/保真文档里出现的 `dsh-omo` 指同一实现。

omo（[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)）的 **explore → plan → execute** 工作流，作为 **一个 DeepSeek Harness Host 插件**。

- 两个指令：`/ulw-plan`（探索、规划、产出 decision-complete 的 plan）与 `/ulw-execute`（把 plan 当成 Boulder 执行）。
- 两个角色命令：`/ulw-consult`（规划前咨询）与 `/ulw-review`（严格 plan 评审）——把角色契约注入**当前会话**就地执行，不派生独立 agent。
- 研究委托走 DSH **原生** `subagent` / `subagent_fork`：explore / librarian 是技能参考里的提示词模板（`references/research-lanes.md`），不是预设 agent。
- 一层硬门禁：规划期（`mode = plan`）拒绝 `write` / `edit` 写入产品文件，只放行 `.dsh/ulw/` 产物。high-accuracy 评审是 plan 工作流的一个**步骤**（会话内评审 + 有界收敛），不再是 momus/oracle 双子代理。

## 安装

插件是**零依赖、零构建**的 ESM bundle（`package.json` + `cordis.patch.yml` + `lib/`）。

### 从 npm（分发版）

在 Web GUI 的 Plugins 页安装 `dsh-ulw-plan`，或通过 Host 的 `plugin_manager`：

```text
plugin_manager { "action": "install_bundle", "target": "dsh-ulw-plan" }
plugin_manager { "action": "set_bundle", "target": "dsh-ulw-plan", "enabled": true }
```

也可以从 tarball、GitHub 或本地目录安装：把 `target` 换成 `/绝对路径/dsh-ulw-plan-0.1.0.tgz`、`github:<owner>/dsh-ulw-plan#<ref>` 或（开发时）本仓库的检出目录。

安装后 profile 的 `package.json` 会把 `dsh-ulw-plan` 放进 `dsh.profile.bundles`，`cordis.patch.yml` 的 `insert` 行把 `dsh-ulw-plan` 挂到 Host 平面。**不要**手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录跑 `pnpm`。

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

两个**会话内角色命令**（替代 omo 的独立 agent）：

| 命令 | 行为 |
| --- | --- |
| `/ulw-consult <请求>` | 校验请求后，把 plan-consultant 契约（`references/plan-consultant.md`）+ 请求文本作为一轮用户消息注入当前会话；`execute` 模式下拒绝 |
| `/ulw-review <plan-path>` | 校验目标（必须是存在的 `.dsh/ulw/plans/<slug>.md`，YAML 拒绝，目录约束强制），计算 sha256，把 plan-reviewer 契约 + 字面路径 + 摘要注入当前会话；`execute` 模式下拒绝 |

两条命令都通过 `agent.followup` 落成普通用户轮次（与 `/goal` 同一座 Host 桥），注入内容模型可见、会话日志可持久。plan 工作流需要评审时，规划者**自己**按同一契约就地执行评审步骤（见 `references/full-workflow.md` 的 in-conversation review step 与有界收敛契约）；用户敲 `/ulw-review` 则由命令完成注入。

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

1. 没有独立角色 agent：consultant / reviewer 是两条会话内命令（`/ulw-consult`、`/ulw-review`），explore / librarian 是研究车道提示词模板，经原生 `subagent` / `subagent_fork` 派发。
2. 没有 `task` 工具：实现者派发用原生 `subagent`，`category` 只是 prompt 词汇（不选模型、不是参数）。
3. high-accuracy 评审是 plan 工作流的会话内步骤（单车道 + 有界收敛 + 草稿里的轮次收据），不再是 momus/oracle 双子代理。
4. 没有 continuation hook；用 `create_goal` 承担续跑。
5. 旧 plan-gate 的三条件简化为命令校验：`/ulw-review` 校验唯一目标路径，两条角色命令在 `execute` 模式拒绝。
6. 新增 `/ulw-mode`。
7. guard 不管 `bash`（与 omo 的 prometheus-md-only 一致，否则 `scaffold-plan.mjs` 无法产出文件）。
8. 模型用 `skill` 工具自行加载 `ulw-plan` 不会切换模式；进入 plan 模式请用 `/ulw-plan` 或 `/ulw-mode plan`。

## 安装后手工检查清单

1. `dsh --profile web --dump-config | grep dsh-ulw-plan` —— 至少一行。
2. `cordis_inspect_query Config.listConfigs name=dsh-ulw-plan` —— 出现该行且为 active。
3. `cordis_inspect_query Tool.listTools` —— 不再含 `task`（委托走原生 `subagent`）。
4. `skills/list` —— 含 `ulw-plan`、`ulw-execute`，且 `invocation.userInvocable === true`。
5. Web 输入 `/` —— 菜单里能看到 `/ulw-plan`、`/ulw-execute`、`/ulw-consult`、`/ulw-review`、`/ulw-mode`。
6. 会话里敲 `/ulw-review <存在的 plan 路径>` —— 出现成功回执，且注入的评审契约作为一条用户消息出现在对话里。

## 开发

```bash
node --test   # Node 26 discovers test/*.test.mjs; a bare directory argument is rejected
node --check lib/*.js skills/ulw-plan/scripts/*.mjs
grep -rn '\.omo' skills | wc -l     # 期望 0（lib/load.js 的运行时改名是唯一登记例外）
```

`docs/fidelity.md` 记录 11 个移植文件的 sha256、57 处 `.omo → .dsh/ulw` 改名、4 处结构性手改，以及 A1/A2/A3 三段追加。

## 发布

`dsh-ulw-plan` 由 GitHub Actions 在 `v*` tag 上 stage 到 npm，维护者用 2FA 批准后上线；Trusted Publisher / bypass token 的完全自动发布路径见 [`docs/publishing.md`](docs/publishing.md)。
