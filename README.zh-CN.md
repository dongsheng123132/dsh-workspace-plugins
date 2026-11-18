# DeepSeek Harness 工作区插件：移到最上面

> **「移到最上面」已搬到新仓库：**最新源码、安装方法和更新都在 **[github.com/dongsheng123132/dsh-move-up](https://github.com/dongsheng123132/dsh-move-up)**。本仓库保留旧版源码，同时包含独立的 Workspace Hub 插件。

作者 / 维护者：He Fangsheng (贺方升 / 贺去病; also known as Dosen)· [hequbing.com](https://www.hequbing.com)

工作区菜单里加一项「移到最上面」，点一次只调一次顺序。[English](README.md)

同一个仓库里还有 **Workspace Hub**（把其他 AI 工具记录的项目目录带进 DSH 侧栏）。两个插件互相独立，装哪个都行。

## 移到最上面（Move to Top）

**把工作区一次性移到列表顶部，不建立收藏体系。**

- 在工作区 `…` 菜单中只增加一项操作。
- 相当于替你完成一次长距离拖动：顺序只写一次，之后仍可自由调整。
- 没有星标、收藏区、固定置顶、自动归位或启动重排。不点它，什么都不会发生。
- 无运行时依赖，不保存排序状态，不跑后台任务。
- 不依赖 Workspace Hub，可单独安装。

包：[`dsh-move-up`](https://www.npmjs.com/package/dsh-move-up)

```sh
dsh plugin --profile desktop add dsh-move-up
```

## 工作区同步（Workspace Hub）

**把其他 AI 工具记录的项目目录带进 DSH 左侧工作区。**

- 扫描本机支持的 AI 工具，维护本地工作区账本。
- 通过官方工作区注册接口添加已存在的项目目录。
- 保留已有工作区标题，不删除项目文件。
- 插件包自带扫描程序，无需另外安装 CLI。
- 可选 Git 传输默认关闭；不复制 DSH 配置、凭据或项目文件内容。

包：[`dsh-plugin-workspace-hub`](https://www.npmjs.com/package/dsh-plugin-workspace-hub)

```sh
dsh plugin --profile desktop add dsh-plugin-workspace-hub@0.3.6
```

## 兼容性与隐私

- 最新版 Move Up 的兼容性、已验证平台和限制，请看[新仓库兼容说明](https://github.com/dongsheng123132/dsh-move-up/blob/main/COMPATIBILITY.md)。
- 本仓库中的旧版代码及 Workspace Hub 曾以 **macOS + DSH 0.2.1-rc.5** 为验证基线；具体限制请查看各自的包说明。
- 工作区同步会读取项目目录元数据并写本地账本。不要公开账本或可选 Git 私有仓。
- 发布包不含用户账本、设备记录、npm 凭据或本机绝对路径。

各插件 README 说明具体行为和限制。

## 许可证

MIT
