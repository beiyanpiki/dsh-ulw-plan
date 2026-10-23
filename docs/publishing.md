# 发布与分发 dsh-ulw-plan

这份文档把「本地可用的插件」变成「别人可以 `dsh plugin add` 的插件」。插件本身是 **零依赖、零构建** 的 ESM bundle：没有 `dependencies`、没有 `postinstall`、没有编译步骤，所以发布和安装只涉及 npm 包与 DSH 的 bundle 声明。

## 0. 结论先说

本仓库用 GitHub Actions 在 **版本 tag** 上自动发布到 npm：

```bash
# 第一次发布前：在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 NPM_TOKEN
git tag v0.1.0
git push origin v0.1.0
```

`v0.1.0` 必须与 `package.json.version` 一致。workflow 会跑测试、校验 tag，然后执行 `npm publish --access public --provenance`，并创建 GitHub Release。

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
| `engines.dsh` | `package.json` → `>=0.2.0-rc.2` | 安装时做兼容性检查（不满足会拒绝激活） |
| 运行文件白名单 | `package.json` → `files` | 保证 `lib/ prompts/ skills/ locale/ cordis.patch.yml icon.svg LICENSE docs/` 都进 tarball |

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

因此 `<spec>` 可以是：

- npm 包名或版本：`dsh-ulw-plan`、`dsh-ulw-plan@0.1.0`、`@scope/dsh-ulw-plan`
- 本机 tarball：`/path/to/dsh-ulw-plan-0.1.0.tgz`
- GitHub：`github:<owner>/<repo>#<ref>`（私有库需要 pnpm 的 git 凭据）
- 本地目录：本仓库的检出目录（开发时用，符号链接方式）

## 2. 发布前检查清单

```bash
cd dsh-ulw-plan

node --test                                   # 53 pass
node --check lib/*.js skills/ulw-plan/scripts/*.mjs
grep -rn '\.omo' skills prompts | wc -l       # 0

npm pack --dry-run                            # 检查实际 tarball 文件列表
npm view dsh-ulw-plan version                      # 404 = 名字可用（2026-10-23 实测可用）
```

`npm pack --dry-run` 至少应包含：

```text
package.json
cordis.patch.yml
icon.svg
locale/en.json
locale/zh.json
lib/*.js
prompts/*.md
skills/ulw-plan/**
skills/ulw-execute/**
README.md
LICENSE
docs/**
```

不要出现 `test/`、`.dsh/`、`.vendor/`、`node_modules/` 或 `*.tgz`。

### 显示元数据

DSH 的 Plugins 页和插件详情不执行插件代码就会读取：

- `locale/en.json` 与 `locale/zh.json` 的 `meta.title` / `meta.description`；
- `icon.svg`（`package.json` 的 `icon` 字段 + `exports["./icon"]` 两处都已声明）；
- 缺失时回退到 `package.json` 的 `name` / `description` 和默认图标。

修改 `locale/*.json` 后，用 `npm pack --dry-run` 确认它们确实在包里；本地目录安装是链接，**不会**受 `files` 过滤。

## 3. 发布方式

### 3.1 CI 自动发布（本仓库已配置，推荐）

- workflow：`.github/workflows/release.yml`
- 触发：push tag `v*`，或在 Actions 页手动 `Run workflow`
- 凭据：仓库 **Settings → Secrets and variables → Actions** 添加 `NPM_TOKEN`

创建 `NPM_TOKEN`：

1. 打开 <https://www.npmjs.com/settings/~/tokens>；
2. **Generate New Token**；
3. classic 选 **Automation**（最简单），或 granular 给 `dsh-ulw-plan` 的 publish 权限；
4. 添加到 GitHub：网页 Settings，或

   ```bash
   gh secret set NPM_TOKEN --repo beiyanpiki/dsh-ulw-plan
   ```

   命令会交互式读取 token；不要把 token 写进仓库或对话。

发布：

```bash
git tag v0.1.0
git push origin v0.1.0
```

workflow 会校验 tag 与 `package.json.version` 一致、跑 `node --test`、执行 `npm publish --access public --provenance`，成功后创建 GitHub Release。

查看：

```bash
gh run list --workflow release.yml --repo beiyanpiki/dsh-ulw-plan
npm view dsh-ulw-plan version
```

失败重试：在 Actions 页对 `Release` 点 **Re-run**，或
`gh workflow run release.yml --repo beiyanpiki/dsh-ulw-plan`（手动触发不校验 tag）。

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

4. 重新 `npm publish`，并同时更新 `.github/workflows/release.yml` 不需要改（它发布 package.json 的名字）。

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

方案 A 只验证包解析与 bundle 声明；要验证真实行为（`/ulw-plan`、`task`、guard）仍需在带 Web 的 profile 里装一次，再按 README 的「安装后手工检查清单」跑一遍。

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
- [<owner>/dsh-ulw-plan](https://github.com/<owner>/dsh-ulw-plan) - 一句话说明：omo 的 explore → plan → execute 工作流，含 /ulw-plan、/ulw-execute、四个只读助手、内联 task 与规划期写入门禁。
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
- `.github/workflows/ci.yml`：push / PR 跑单元测试、语法检查、改名门禁与 `npm pack --dry-run`
- `.github/workflows/release.yml`：tag `v*` 发布 npm 并创建 GitHub Release

仍需你设置：

- **`NPM_TOKEN` repository secret**（第 3.1 节）。这是第一次发布唯一的人工步骤。
- 如需改作者署名或许可证持有人，在 `package.json` 与 `LICENSE` 同步修改。

补齐 `NPM_TOKEN` 后，发布就是：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 10. 已验证的打包结果（2026-10-23）

在改名为 `dsh-ulw-plan` 之后重跑了一次完整的打包/安装演练：

- `npm pack` → `dsh-ulw-plan-0.1.0.tgz`：**32 个文件**，约 86.5 kB packed / 228.8 kB unpacked；包含 `package.json`、`cordis.patch.yml`、`icon.svg`、`locale/{en,zh}.json`、`lib/`、`prompts/`、`skills/`、`docs/`、`README.md`、`LICENSE`，不含 `test/`、`.dsh/`、`.vendor/`、`node_modules/`。
- 临时项目 `pnpm add ../../dsh-ulw-plan-0.1.0.tgz` 后：`import('dsh-ulw-plan')` 得到 `apply` / `inject` / `name`（`name` 为 `dsh-ulw-plan`）；`import.meta.resolve('dsh-ulw-plan/icon')` 解析到包内 `icon.svg`；`dsh-ulw-plan/locale/en.json` 与 `zh.json` 正常解析出 `omo Workflow` / `omo 工作流`。
- 新建 `distweb` profile（`dsh --profile distweb --from-default-profile web`）后：
  `dsh plugin --profile distweb add ./dsh-ulw-plan-0.1.0.tgz`
  → profile 依赖变成 `"dsh-ulw-plan": "file:…/dsh-ulw-plan-0.1.0.tgz"`，`dsh.profile.bundles` 自动追加 `dsh-ulw-plan`，`dsh --profile distweb --dump-config` 出现：
  ```yaml
  # == dsh-ulw-plan
  - id: omo
    name: dsh-ulw-plan
  ```
- 本机 web profile 也已从旧的 `dsh-omo` link 切换到 `dsh-ulw-plan`: link，`dump-config` 同样出现上面的行。
- 该 distweb profile 只用于安装演练，未启动服务；真实行为（`/ulw-plan`、`task`、guard、preset）的证据在主仓库 web profile 的 `.dsh/ulw/evidence/` 中。

复现这条演练不需要 npm 账号；`npm publish` 才需要 `NPM_TOKEN` / `npm login`。
