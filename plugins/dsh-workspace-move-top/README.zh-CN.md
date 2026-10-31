# 移到最上面

[English](README.md)

在 DSH 工作区 `…` 菜单中增加“移到最上面”。点击一次，通过官方 `workspaceRegistry.insertBefore` 接口完成一次排序，相当于替你完成一次长距离拖动。

- 没有星标、收藏区或自动归位。
- 之后把另一个项目移到第一，原来的自然退到第二。
- 仍可自由拖动；启动与同步时不恢复旧顺序。
- 不依赖工作区同步插件，可单独安装。

## 安装

```sh
dsh plugin --profile desktop add dsh-plugin-workspace-move-top@0.2.1
```

## 兼容性与限制

已在 **macOS + DSH 0.2.1-rc.5** 验证，本版本精确对应该宿主。菜单根据浏览器语言显示中文或英文。

宿主没有工作区菜单扩展位，因此客户端使用当前工作区行和菜单 DOM。宿主改变该结构后，菜单项可能消失；插件不会因此自行排序。Windows 真机与非空会话菜单的浏览器行为尚未验证。

## 验证

```sh
npm ci
npm run check
```
