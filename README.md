# dsh-omo

omo（[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)）的 **explore → plan → execute** 工作流，作为 **一个 DeepSeek Harness Host 插件**。

- 两个指令：`/ulw-plan`（探索、规划、产出 decision-complete 的 plan）与 `/ulw-execute`（把 plan 当成 Boulder 执行）。
- 四个只读助手：`explore`、`librarian`、`plan-consultant`、`plan-reviewer`；`task` 工具另接 `metis` / `momus` / `oracle` 三个兼容别名。
- 一层硬门禁：规划期（`mode = plan`）拒绝 `write` / `edit` 写入产品文件，只放行 `.dsh/ulw/` 产物；plan-gate 复刻 omo 的三条件。

## 安装

插件是**零依赖、零构建**的 ESM bundle（`package.json` + `cordis.patch.yml` + `lib/`）。

在 Web GUI 的插件配置里用「安装 bundle」指向本目录，或通过 Host 的 `plugin_manager` 工具：

```text
plugin_manager { "action": "install_bundle", "target": "/home/miku/dsh-omo" }
plugin_manager { "action": "set_bundle", "target": "dsh-omo", "enabled": true }
```

安装后 profile 的 `package.json` 会把 `dsh-omo` 放进 `dsh.profile.bundles`，`cordis.patch.yml` 的 `insert` 行把 `dsh-omo` 挂到 Host 平面。**不要**手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录跑 `pnpm`。

## 使用

### `/ulw-plan <请求>`

在一个普通会话里键入 `/ulw-plan`，技能正文被注入，会话进入 **plan 模式**：

- 首行必须出现 `ULW-PLAN MODE ENABLED!`（omo 原文的契约）。
- 助手只做只读探索（`explore` / `librarian`，以及规划期的 `plan-consultant` / `plan-reviewer`）。
- 产物只写 `.dsh/ulw/`：`drafts/<slug>.md`、`plans/<slug>.md`。
- 产品文件写入会被 guard 拒绝，并提示退出方式。

### `/ulw-execute [plan-name]`

技能正文被注入，会话进入 **execute 模式**：按 plan 的 checkbox 派发实现者（`task(category="…")`），用 Boulder / ledger 记录状态。

### `/ulw-mode off|plan|execute`

omo 没有的逃生口：显式切换本会话的 ulw 模式。投影也接受用户直接敲 `/ulw-plan` / `/ulw-execute` 的自然入口。

## 四个助手

| 助手 | 用途 | 工具面 |
| --- | --- | --- |
| `explore` | 代码库定位、调用点、结构 | 只读：read / glob / grep + bash |
| `librarian` | 外部文档、远程仓库、官方链接 | 上述 + web_search / web_fetch |
| `plan-consultant`（别名 `metis`） | 规划前咨询：隐藏意图、歧义、AI 失败点 | 只读 |
| `plan-reviewer`（别名 `momus` / `oracle`） | 严格 plan 评审：只找 blocker | 只读 |

四个助手都以 preset 形式注册在 Web 的预设选择器里，名字前缀 `omo `。它们**没有** `write` / `edit` 工具——只读是工具面事实，不是提示词请求。
`task` 一律内联等待结果返回；`run_in_background` 仅为兼容接受，不改变行为。

## 产物

```text
.dsh/ulw/drafts/<slug>.md
.dsh/ulw/plans/<slug>.md
.dsh/ulw/boulder.json
.dsh/ulw/ulw-execute/ledger.jsonl
```

路径与 omo 的 `.omo/` 同构，只做了目录改名（见 `docs/fidelity.md`）。`.dsh/ulw/evidence/` 建议不进版本库。

## 与 omo 的差异

完整清单在 `docs/fidelity.md` 的「已知行为差异」。要点：

1. `task` 一律内联；不实现后台投递。
2. 没有 `task_output` / `task_send` / `task_cancel`；用 DSH 的 `send_message` / `interrupt_agent` / 结算通知。
3. 没有 continuation hook；用 `create_goal` 承担续跑。
4. `category` 不选模型。
5. plan-gate 的「本会话触碰过 plan」简化为「mode=plan 且产物存在」。
6. 新增 `/ulw-mode`。
7. guard 不管 `bash`（与 omo 的 prometheus-md-only 一致，否则 `scaffold-plan.mjs` 无法产出文件）。
8. 模型用 `skill` 工具自行加载 `ulw-plan` 不会切换模式；进入 plan 模式请用 `/ulw-plan` 或 `/ulw-mode plan`。

## 安装后手工检查清单

1. `dsh --profile web --dump-config | grep dsh-omo` —— 至少一行。
2. `cordis_inspect_query Config.listConfigs name=dsh-omo` —— 出现该行且为 active。
3. `cordis_inspect_query Tool.listTools` —— 含 `task`。
4. `skills/list` —— 含 `ulw-plan`、`ulw-execute`，且 `invocation.userInvocable === true`。
5. `agentPresets.list()` —— 含四个 `omo ` 前缀 preset，均无 `broken` 字段。
6. Web 输入 `/` —— 菜单里能看到 `/ulw-plan` 与 `/ulw-execute`。

## 开发

```bash
node --test   # Node 26 discovers test/*.test.mjs; a bare directory argument is rejected
node --check lib/*.js skills/ulw-plan/scripts/*.mjs
grep -rn '\.omo' skills prompts | wc -l   # 期望 0（lib/load.js 的运行时改名是唯一登记例外）
```

`docs/fidelity.md` 记录 11 个移植文件的 sha256、57 处 `.omo → .dsh/ulw` 改名、4 处结构性手改，以及 A1/A2/A3 三段追加。
