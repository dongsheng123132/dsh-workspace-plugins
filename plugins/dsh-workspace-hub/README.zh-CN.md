# 工作区同步（Workspace Hub）

[English](README.md)

把 Claude Code、Codex、Cursor、Trae、WorkBuddy 等 AI 工具记录的工作目录合并到账本，再通过官方 `workspaceRegistry.create()` API 补入 DSH 左侧工作区。按 realpath 去重，只加不减，不覆盖已有标题。插件注册四个模型工具，无客户端入口、收藏工具或排序路由。

本包包含扫描 CLI 的必要源码，无需克隆仓库或另装 wshub。要求 Node ≥22；DSH 的 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/dsh-workspace` 精确匹配 **0.2.1-rc.5**，Cordis ~4.0.5、Schemastery ~3.18.5。

## 安装

在 DSH 的 **Plugins → Add plugin → Install a third-party plugin** 中填写 `dsh-plugin-workspace-hub@0.3.6`，安装后启用。也可使用与运行中 DSH 相同版本的 CLI（桌面 profile 按宿主要求退出 App）：

```sh
dsh plugin --profile desktop add dsh-plugin-workspace-hub@0.3.6
```

普通 npm 安装命令如下；它下载包，但不会自行在 DSH 中启用 bundle：

```sh
npm install dsh-plugin-workspace-hub@0.3.6
```

尚未发布时，维护者可 `npm ci && npm run check && npm pack`，再让 DSH 安装生成的本地 tgz。不要直接用本仓库根目录安装：npm 包位于 `plugins/dsh-workspace-hub`，元数据中的 repository.directory 指向该子目录。

## 配置与默认行为

默认账本位置依次为 `$WSHUB_HOME/ledger.json`、`$WDHUB_HOME/ledger.json`、`~/.workspace-hub/ledger.json`。首次激活默认先扫描本机各工具并保存账本，然后同步进 DSH。扫描失败只报告并使用已有账本，不阻止插件加载。

通过 profile patch 覆盖 row `wshub-workspace-hub` 的 config：

```yaml
- id: wshub-workspace-hub
  config:
    maxAdd: 30
    dryRun: true
    scanOnStart: true
    intervalSeconds: 0
    gitRepo: ''
    gitSyncOnStart: false
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `ledgerPath` | 上述默认位置 | 支持 `~/`；运行时绝对化 |
| `maxAdd` | `30` | 每轮新增上限，`0` 不限 |
| `dryRun` | `false` | 只演练 DSH 注册操作；**不会禁止启动扫描写账本或显式 Git 同步** |
| `scanOnStart` | `true` | 激活时扫描并保存账本 |
| `intervalSeconds` | `0` | `0` 关闭定时器；非零仅重新读取已有账本并同步，**不重新扫描各工具** |
| `hubCliPath` | `''` | 优先包内 `hub/wdhub.mjs`，不存在时回退旧仓库路径；可明确指定外部 CLI |
| `scanTimeoutMs` | `60000` | 扫描超时，毫秒 |
| `gitRepo` | `''` | 可选 Git 私有仓地址；默认关闭跨设备同步 |
| `gitSyncOnStart` | `false` | 开启且有 gitRepo 时，激活执行拉取 → 扫描 → 推送，替代单独启动扫描 |
| `gitTimeoutMs` | `180000` | Git 整轮超时，毫秒 |

Git 拉取失败会停止并报告，保留本地现场，不执行硬重置。Git 跨设备同步需要本机已安装 git 并自行配置 SSH/凭据。本包不包含凭据，也不复制项目文件或会话内容；远端存储的是目录元数据和账本事件，可能包含目录名称、路径与设备信息，请使用自己信任的私有仓。不同电脑的路径根可能需要通过旧 CLI 的 device/root alias 配置对齐。

## 模型工具与服务

- `workspace_hub_list`：只读列出账本，标注已在 DSH、可新增和跳过项。
- `workspace_hub_sync({ dryRun?, maxAdd? })`：读取现有账本并同步；不会扫描。参数可覆盖本轮配置。
- `workspace_hub_refresh({ dryRun?, maxAdd? })`：扫描并保存账本，再同步。`dryRun` 仅约束后半段 DSH 写入。
- `workspace_hub_remote_sync()`：显式执行 Git 拉取 → 扫描 → 推送 → 同步，需要 gitRepo；此工具没有 dryRun 参数。

工具返回结构化结果和中文文本。服务键是 `ctx.wshubWorkspaceHub`，提供 `inspect()`、`sync(options)`、`refresh(options)`、`autoSync()`、最近一次扫描/同步结果。同步队列串行处理创建操作。

## 同步与旧 CLI 安全边界

只新增存在的 `kind: project` 目录；缺失 kind 按 project 兼容。应用托管目录、文件、失效路径、重复路径和超过上限的条目会跳过。账本顺序在新增批次中保留，内部 pinned 元数据仍兼容，但插件不提供收藏操作、不调整既有工作区顺序。已存在条目不会重命名或自动删除；上游墓碑不自动删除 DSH 注册。账本旁的 exclude.json 屏蔽名单仍受支持。

包内 `hub/` 按本仓库 CLI 原布局保留入口、适配器及必要 lib（包括 MCP 的动态入口），Windows/macOS 路径和平台分支保留。只读扫描不改其它工具的状态；SQLite 数据库会先复制到临时文件读取，优先 Node 的 SQLite，缺失时尝试系统 sqlite3。不存在的工具会作为无数据/不适用报告。

旧 CLI 仍含高级命令，它们并非都只读：`scan --save`、adopt/remove 写账本；sync/auto/git-sync 可提交和推送 Git；open 会启动工具；setup/integrations --apply 会写工具配置、hook 或定时任务，且依赖完整仓库的 skill 资源，**npm 包不承诺该安装流程可用**；dsh-prune --apply 会直接清理 DSH 存储，要求退出 DSH 并保留备份；--lock-exclude 写屏蔽名单。插件自动路径只使用 scan 和按配置显式启用的 auto，不自动执行这些高级写操作。不要把旧 CLI 的 --dry-run 理解为所有命令均无文件副作用：某些身份初始化/事件播种可能在预演前发生。

扫描账本会暴露本机目录元数据。输出按原路径展示；不要把账本、日志或 Git 远端当作凭据保险箱。包内不附带用户账本、设备身份、会话、.npmrc 或密钥。

## 验证与局限

```sh
npm ci
npm run check
npm pack --dry-run
node ~/.dsh/skills/plugin-write/scripts/validate-names.mjs --manifest ./dsh-plugin.naming.json --strict
```

测试使用真实 Cordis、Schemastery 和 ToolRuntime，注册表为隔离测试端口；打包冒烟会将 npm pack 产物离线安装到临时消费目录，在临时 HOME/APPDATA/账本下执行默认 CLI 扫描，证明不依赖包外源码。测试不使用真实用户账本或 Git 凭据。

默认新鲜度由激活和 refresh 决定。定时器和 sync 都只消费旧账本，因此外部工具中新建的项目要等下次激活或主动 refresh 才被发现。未监听账本文件，不同步标题/删除，不同步项目内容。适配器格式可能随外部工具升级变化，实验适配器不保证完整识别。Windows 路径分支保留不等于 Windows 真机验收；当前 smoke 仅证明执行环境所在平台。真实桌面 UI、跨设备 Git 网络流程和完整旧 CLI setup 安装均不在此次发布准备的实测范围。
