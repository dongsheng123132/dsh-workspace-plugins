# DeepSeek Harness 工作区插件

两个独立、极简的 DSH 左侧工作区插件。[English](README.md)

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

## 移到最上面（Move to Top）

**把工作区一次性移到列表顶部，不建立收藏体系。**

- 在工作区 `…` 菜单中增加一项操作。
- 相当于替你完成一次长距离拖动，之后仍可自由调整顺序。
- 没有星标、收藏区、自动归位或收藏记录。
- 不依赖 Workspace Hub，可单独安装。

包：[`dsh-plugin-workspace-move-top`](https://www.npmjs.com/package/dsh-plugin-workspace-move-top)

```sh
dsh plugin --profile desktop add dsh-plugin-workspace-move-top@0.2.1
```

## 兼容性与隐私

- 已在 **macOS + DSH 0.2.1-rc.5** 验证；插件 peer 依赖精确对应该宿主版本。
- 保留 Windows 路径处理分支，但尚未完成 Windows 真机验收。
- 工作区同步会读取项目目录元数据并写本地账本。不要公开账本或可选 Git 私有仓。
- 移到最上面使用当前工作区菜单 DOM，因为宿主尚未提供工作区菜单扩展位。宿主界面变更可能让菜单项消失；插件不会因此自行调整顺序。
- 发布包不含用户账本、设备记录、npm 凭据或本机绝对路径。

各插件 README 说明具体行为和限制。

## 许可证

MIT
