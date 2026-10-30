# 发布与分发 dsh-ulw-plan

这份文档把「本地可用的插件」变成「别人可以 `dsh plugin add` 的插件」。插件本身是 **零依赖、零构建** 的 ESM bundle：没有 `dependencies`、没有 `postinstall`、没有编译步骤，所以发布和安装只涉及 npm 包与 DSH 的 bundle 声明。

> 本文描述的是**现行**打包面：43 个文件（第 2 节逐项列出）。包名是 `dsh-ulw-plan`，bundle row id 仍是 `omo`；项目更早的名字 `dsh-omo` 只出现在历史记录里，现行命令以本文与 README 为准。

## 0. 结论先说

本仓库用 GitHub Actions 在 **版本 tag** 上把包 **stage 到 npm**；因为 npm 账号启用了 2FA，最后由维护者用 2FA 批准上线（npm 的 staged publishing）：

```bash
# 第一次发布前：在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 NPM_TOKEN
git tag v0.1.0
git push origin v0.1.0
```

`v0.1.0` 必须与 `package.json.version` 一致。workflow 会跑测试、校验 tag、执行 `npm stage publish --access public --provenance`。

然后批准（二选一）：

```bash
npm stage list dsh-ulw-plan                 # 需要本机已 npm login
npm stage approve <stage-id> --otp <6位码>  # 或 npmjs.com → 包页面 → Staged versions
```

批准后版本才真正公开。想要完全无人值守发布，见第 3.1 节的 Trusted Publisher / bypass token 说明。

任何一台 DSH 机器安装：

```text
# Web GUI → Plugins → 安装 bundle → dsh-ulw-plan
plugin_manager { "action": "install_bundle", "target": "dsh-ulw-plan" }
plugin_manager { "action": "set_bundle", "target": "dsh-ulw-plan", "enabled": true }
```

发布前必须存在的三样东西已经在仓库里：

| 声明 | 位置 | 作用 |
| --- | --- | --- |
| `dsh.bundle.patch` | `package.json` → `./cordis.patch.yml` | DSH 据此识别「这是一个 bundle」并合并它的 Host 行 |
| `engines.dsh` | `package.json` → `>=0.2.0-rc.2` | 安装时的**基础面**兼容性下限；增强评审面另按 API 检测（见 0.1） |
| 运行文件白名单 | `package.json` → `files` | 保证 `lib/ skills/ locale/ docs/fidelity.md docs/publishing.md cordis.patch.yml icon.svg README.md LICENSE` 进 tarball；逐文件清单见第 2 节 |

### 0.1 分发版行为边界（与 README、`docs/fidelity.md` 一致）

- **基础面装包即用**：`/ulw-plan`、`/ulw-execute`、`/ulw-consult`、`/ulw-mode`、规划期写入门禁，以及 `/ulw-review` 的目标校验。研究委托与实现者派发走 Host 原生 `subagent` / `subagent_fork`（包内没有额外的内联子代理工具）。
- **增强评审默认关闭**：Host 双车道计划评审与 `ulw_review` / `ulw_handoff` 只在用户显式写 `review` 配置后才有授权；不写（或 `enabled: false`）就是安全默认，零模型调用、不产生 requirement，入口以 `CAPABILITY_UNAVAILABLE` 拒绝，且**不会**退回 inline 审批。
- **已验证版本是 DSH 0.2.1-rc.4**（本机安装）。`engines.dsh` 的 `>=0.2.0-rc.2` 只是基础面下限，该版本早于这组增强 API，本文不声称旧下限已经具备它们；未装配增强服务的 Host 上，增强入口给诊断，不谎报评审完成。
- **公开 GUI 的模型 allowlist 不是评审服务的配置**：它只约束那个 GUI 面的工具选择，既不授权评审路由，也不会被插件读取来扩大路由。授权只来自 profile 里显式的 `review` 块（示例与解析规则见 README「配置：默认关闭，显式授权」）。
- **profile 归属**：安装器（`plugin_manager` / `dsh plugin add`）负责 profile 的依赖条目与 `dsh.profile.bundles`，不要手工维护这两处，也不要在 profile 目录里跑 `pnpm`；profile 的 `cordis.patch.yml` 是受支持的**用户覆盖层**，用它按 row id（`omo`）覆盖插件配置。

## 1. DSH 如何找到并安装一个插件

DSH 的 `plugin_manager.install_bundle`（以及 Web Plugins 页的安装按钮）本质上是在 **当前 profile 目录**里执行：

```text
pnpm add <spec>
```

然后：

1. 读取安装后 `package.json` 的 `dsh.bundle.patch`，确认是 bundle；
2. 用 `engines.dsh`（没有则看 `@deepseek-ai/dsh-*` peerDependencies）检查运行时兼容性；
3. 把 `cordis.patch.yml` 的 `insert` 行合并进 profile 组合；
4. 把包名写入 `dsh.profile.bundles` 并尝试热加载。

第 3、4 步的落盘由安装器负责；升级、删除也走同一个入口，见第 5 节。因此 `<spec>` 可以是：

- npm 包名或版本：`dsh-ulw-plan`、`dsh-ulw-plan@0.1.0`、`@scope/dsh-ulw-plan`
- 本机 tarball：`/path/to/dsh-ulw-plan-0.1.0.tgz`
- GitHub：`github:<owner>/<repo>#<ref>`（私有库需要 pnpm 的 git 凭据）
- 本地目录：本仓库的检出目录（开发时用，符号链接方式）

## 2. 发布前检查清单

```bash
cd dsh-ulw-plan

node --test                                   # 全绿（写稿时 466 项通过，数字随实现推进增长）
for file in lib/*.js skills/*/scripts/*.mjs qa/*.mjs test/*.test.mjs; do node --check "$file"; done
grep -rn '\.omo' skills | wc -l              # 0

npm pack --dry-run --json                     # 检查实际 tarball 文件列表
npm view dsh-ulw-plan version                 # 404 = 名字可用（2026-10-23 实测可用）
```

`npm pack --dry-run --json` 的 `files` 数组应**恰好是**下面 43 项（顺序与 npm 输出一致，写稿时实测）：

```text
LICENSE
README.md
cordis.patch.yml
docs/fidelity.md
docs/publishing.md
icon.svg
lib/commands.js
lib/guard.js
lib/index.js
lib/load.js
lib/paths.js
lib/projection.js
lib/review-artifact.js
lib/review-config.js
lib/review-coordinator.js
lib/review-handoff.js
lib/review-input.js
lib/review-lint.js
lib/review-policy.js
lib/review-presets.js
lib/review-protocol.js
lib/review-state.js
lib/review-store.js
lib/review-tools.js
lib/review-transport.js
lib/skills.js
locale/en.json
locale/zh.json
package.json
skills/ulw-execute/scripts/plan-state.mjs
skills/ulw-execute/SKILL.md
skills/ulw-plan/references/dsh-harness.md
skills/ulw-plan/references/full-workflow.md
skills/ulw-plan/references/intent-clear.md
skills/ulw-plan/references/intent-unclear.md
skills/ulw-plan/references/plan-adversarial-reviewer.md
skills/ulw-plan/references/plan-consultant.md
skills/ulw-plan/references/plan-reviewer.md
skills/ulw-plan/references/research-lanes.md
skills/ulw-plan/scripts/plan-lint.mjs
skills/ulw-plan/scripts/plan-templates.mjs
skills/ulw-plan/scripts/scaffold-plan.mjs
skills/ulw-plan/SKILL.md
```

不要出现 `test/`、`qa/`、`.dsh/`、`.vendor/`、`node_modules/`、`.github/`、`docs/migration-plan.md` 或 `*.tgz`。`docs/migration-plan.md` 是内部迁移记录（含本机绝对路径），`files` 只放行 `docs/fidelity.md` 与 `docs/publishing.md` 两份文档。`test/review-package.test.mjs` 会把同一份清单（以及“不含私有路径/凭据”的断言）当作包契约反复校验。

### 显示元数据

DSH 的 Plugins 页和插件详情不执行插件代码就会读取：

- `locale/en.json` 与 `locale/zh.json` 的 `meta.title` / `meta.description`；
- `icon.svg`（`package.json` 的 `icon` 字段 + `exports["./icon"]` 两处都已声明）；
- 缺失时回退到 `package.json` 的 `name` / `description` 和默认图标。

修改 `locale/*.json` 后，用 `npm pack --dry-run` 确认它们确实在包里；本地目录安装是链接，**不会**受 `files` 过滤。

## 3. 发布方式

### 3.1 CI 发布（本仓库已配置）

- workflow：`.github/workflows/release.yml`
- 触发：push tag `v*`，或在 Actions 页手动 `Run workflow`
- 凭据：仓库 **Settings → Secrets and variables → Actions** 添加 `NPM_TOKEN`

创建 `NPM_TOKEN`：

1. 打开 <https://www.npmjs.com/settings/~/tokens>；
2. **Generate New Token**；
3. classic 选 **Automation** 或 granular 给 `dsh-ulw-plan` 的 publish 权限；
4. 添加到 GitHub：网页 Settings，或

   ```bash
   gh secret set NPM_TOKEN --repo beiyanpiki/dsh-ulw-plan
   ```

   命令会交互式读取 token；不要把 token 写进仓库或对话。

**为什么是 stage 而不是直接 publish**：npm 对启用 2FA 的账号要求「granular token with bypass 2FA」才能从 CI 直接发布；普通 token 直接 `npm publish` 会得到 403：

```text
403 Forbidden - PUT https://registry.npmjs.org/<pkg>
Two-factor authentication or granular access token with bypass 2fa enabled is required
```

Staged publishing 把 2FA 推迟到批准时，因此普通 token 也能由 CI 上传。

发布：

```bash
git tag v0.1.0
git push origin v0.1.0
```

workflow 会校验 tag 与 `package.json.version`、跑 `node --test`、执行 `npm stage publish --access public --provenance`。之后：

```bash
npm stage list dsh-ulw-plan
npm stage approve <stage-id> --otp <你的6位码>
# 或 npmjs.com → 你的包 → Staged versions → Approve
```

批准后：

```bash
npm view dsh-ulw-plan version
gh release create v0.1.0 --generate-notes --verify-tag
```

查看/重跑 workflow：

```bash
gh run list --workflow release.yml --repo beiyanpiki/dsh-ulw-plan
gh workflow run release.yml --repo beiyanpiki/dsh-ulw-plan
```

**想要完全自动发布**（无人工批准）有两种升级路径：

1. 创建一个 **granular access token，勾选 “Bypass two-factor authentication (2FA)”**，把 `NPM_TOKEN` 换成它，并把 workflow 的 `npm stage publish` 改回 `npm publish --access public --provenance`。
2. 更推荐：包第一次上线后，在 npmjs.com → 包 → Settings → **Trusted publishing** 添加 GitHub 发布者（repo `beiyanpiki/dsh-ulw-plan`，workflow `release.yml`，允许 direct publish），然后删除 `NPM_TOKEN` 凭据，把 workflow 改回 `npm publish`；npm CLI 会自动使用 GitHub OIDC，不再需要长期 token。

### 3.2 手动发布（备用）

```bash
npm login
npm publish --access public
npm view dsh-ulw-plan version
```

如果 `dsh-ulw-plan` 已被占用或你想用 scope：

1. 把 `package.json` 的 `name` 改成 `@your-scope/dsh-ulw-plan`；
2. 保持 `publishConfig.access: "public"`；
3. 同步修改 `cordis.patch.yml` 中行的 `name`（它必须等于包名）。当前是：

```yaml
- insert:
    - id: omo
      name: dsh-ulw-plan
```

4. 重新 `npm publish`；`.github/workflows/release.yml` 不需要改（它发布 `package.json` 里的名字）。

## 4. 用打包产物做一次真实安装验证

发布前不依赖 npm，也能验证「别人拿到 tarball 能装」：

```bash
npm pack                                  # 生成 dsh-ulw-plan-0.1.0.tgz

# 方案 A：临时 profile（会创建 ~/.dsh/profiles/distcheck）
dsh plugin --profile distcheck add ./dsh-ulw-plan-0.1.0.tgz
dsh --profile distcheck --dump-config | grep -n dsh-ulw-plan

# 方案 B：当前 web profile（先卸掉本地 link 版本再装 tarball）
plugin_manager { "action": "remove_bundle", "target": "dsh-ulw-plan" }
plugin_manager { "action": "install_bundle", "target": "/绝对路径/dsh-ulw-plan-0.1.0.tgz" }
plugin_manager { "action": "set_bundle", "target": "dsh-ulw-plan", "enabled": true }
```

方案 A 只验证包解析与 bundle 声明；要验证真实行为（`/ulw-plan`、`/ulw-execute`、规划期 guard、`ulw_handoff` 的 lease、`ulw_review` 的双车道）仍需在带 Web 的 profile 里装一次，再按 README 的「安装后手工检查清单」跑一遍。

## 5. 升级已有安装

`install_bundle` 对已存在的同名依赖会返回 `already-installed`，这是 DSH 的保护，不是错误。升级路径：

```text
plugin_manager { "action": "remove_bundle", "target": "dsh-ulw-plan" }
plugin_manager { "action": "install_bundle", "target": "dsh-ulw-plan@0.1.1" }
plugin_manager { "action": "set_bundle", "target": "dsh-ulw-plan", "enabled": true }
```

或者让 dsh-market 的「更新」按钮处理（需要先按第 6 节上架）。替换同名的已加载 JavaScript 模块通常需要重启进程；Web 页面上会显示 `restart-required` 之类的提示。

## 6. 上架 DSH 插件市场

dsh-market 的目录来自社区仓库 **awesome-dsh-plugin**，不是 dsh-market 自身：

1. 先确保插件能以 `dsh plugin add` 安装（npm 或 GitHub 均可）；
2. 在 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 提交一个 PR，在 `## Workflow & Automation` 分类下加一行，格式是：

```markdown
- [<owner>/dsh-ulw-plan](https://github.com/<owner>/dsh-ulw-plan) - 一句话说明：omo 的 explore → plan → execute 工作流，含 /ulw-plan、/ulw-execute、两条角色命令、原生子代理研究委托、Host 双车道计划评审与执行 lease 门禁（增强面默认关闭）。
```

3. 维护者可要求 `dsh plugin add` 真实可复现、描述与行为一致、分类正确；合并后 dsh-market 和 `dsh-plugin-catalog/index.json` 会自动收录。

也可以不上架市场，直接分享 tarball、GitHub 仓库或私有 npm registry；DSH 的安装器不要求市场存在。

## 7. 私有 / 内部分发

- **tarball**：`npm pack` 后把 `.tgz` 发给对方，`install_bundle` 指向绝对路径。
- **私有 registry**：配置 npm token 或 pnpm 的 registry，`install_bundle` 的 `registry` 参数可指定优先 registry。
- **私有 GitHub**：`github:<owner>/<repo>#<sha>`；确保目标机器有读取权限。
- **本地目录**：当前开发方式，`link:` 安装；`files` 不生效，改文件即时可见。

## 8. 常见失败与排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `not-bundle` | tarball 里没有 `dsh.bundle.patch`，或 `files` 漏了 `cordis.patch.yml` | 用 `npm pack --dry-run` 确认，再发布 |
| `incompatible-version` | `engines.dsh` 与运行时版本不匹配 | 放宽 `engines.dsh` 或让用户升级 DSH；不要随意给版本豁免 |
| 安装成功但没有 `dsh-ulw-plan` 行 | bundle 未启用，或 patch 行 `name` 与包名不一致 | `set_bundle` 启用；核对 `cordis.patch.yml` |
| 图标/标题是默认值 | `locale/en.json` 未导出或 `files` 漏了 `locale/` | 检查 `exports["./locale/*.json"]` 与 tarball |
| 改代码后行为没变 | 同名包替换后模块缓存未失效 | 重启 DSH 进程，或先 `remove_bundle` |
| 没有 `pnpm` | DSH 安装器依赖 pnpm | 安装 pnpm 后重试；dsh-market 有一键安装提示 |

## 9. 本仓库已设置 / 仍需设置

已设置：

- `repository` / `homepage` / `bugs` → <https://github.com/beiyanpiki/dsh-ulw-plan>
- `author` → `beiyanpiki`；`LICENSE` → `dsh-ulw-plan contributors`
- `.github/workflows/ci.yml`：push / PR 在 Node 22 / 24 / 26 上跑 `node --test`；独立的 packaging job（Node 24）跑语法检查、产物根改名门禁、`test/review-package.test.mjs` 与 `npm pack --dry-run`
- `.github/workflows/release.yml`：tag `v*` 校验 tag 与版本一致后，把版本 stage 到 npm（2FA 批准后上线）

仍需你决定：

- **每次发布的人工批准**（staged publishing 的 2FA）。如果想完全自动，按第 3.1 节升级为 bypass token 或 Trusted Publisher。
- 如需改作者署名或许可证持有人，在 `package.json` 与 `LICENSE` 同步修改。

## 10. 已验证的打包结果（2026-10-30）

按现行 `files` 白名单重跑了一次打包演练；逐项清单见第 2 节，`test/review-package.test.mjs` 对同一份清单做机械断言。

- `npm pack --dry-run --json` → **43 个文件**：`package.json`、`cordis.patch.yml`、`icon.svg`、`locale/{en,zh}.json`、`lib/` 的 20 个模块、`skills/ulw-plan/**` 的 12 个文件、`skills/ulw-execute/**` 的 2 个文件、`docs/fidelity.md`、`docs/publishing.md`、`README.md`、`LICENSE`；不含 `test/`、`qa/`、`.dsh/`、`.vendor/`、`node_modules/`、`.github/`、`docs/migration-plan.md`。
- 把这 43 个文件原样复制到一个隔离目录后：`import` 包入口得到 `apply` / `inject` / `name`（`name` 为 `dsh-ulw-plan`）；`loadSkill('ulw-plan')` 读出含 `ULW-PLAN MODE ENABLED!` 的技能正文；`icon.svg` 与 `locale/{en,zh}.json`（`omo Workflow` / `omo 工作流`）都能从包内读出；两份 reviewer 契约（`plan-reviewer.md`、`plan-adversarial-reviewer.md`）也随包发出。
- 更早的一次 distweb 临时 profile 演练（2026-10-23，改名之后）记录如下，只证明包解析与 bundle 声明：`dsh plugin --profile distweb add ./dsh-ulw-plan-0.1.0.tgz` 后 profile 依赖变成 `"dsh-ulw-plan": "file:…/dsh-ulw-plan-0.1.0.tgz"`，`dsh.profile.bundles` 自动追加 `dsh-ulw-plan`，`dsh --profile distweb --dump-config` 出现：

  ```yaml
  # == dsh-ulw-plan
  - id: omo
    name: dsh-ulw-plan
  ```

- 该演练 profile 只用于安装验证，未启动服务；真实行为（技能、guard、评审、handoff）的证据在 workspace 的 `.dsh/ulw/evidence/` 中。

> 历史：项目更早的一次演练记录用的是旧包名 `dsh-omo` 与旧评审面，只作对照，不要据此复现；现行清单与命令以上文和 README 为准。

复现这条演练不需要 npm 账号；`npm publish` 才需要 `NPM_TOKEN` / `npm login`。
