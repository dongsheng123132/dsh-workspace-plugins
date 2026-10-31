# Move to Top

[中文说明](README.zh-CN.md)

Add **Move to top** to a DSH workspace's `…` menu. One click performs one reorder through the host's official `workspaceRegistry.insertBefore` API, just like a long manual drag.

- No stars, favorites, pinned categories, or automatic reordering.
- Move another workspace later and the previous one naturally moves down.
- Manual dragging remains yours; activation and synchronization never restore an old order.
- Works independently of Workspace Hub.

## Install

```sh
dsh plugin --profile desktop add dsh-plugin-workspace-move-top@0.2.1
```

## Compatibility and limits

Tested with **DSH 0.2.1-rc.5 on macOS**. This release targets that exact host version. Menu copy follows the browser language: Chinese or English.

The host has no workspace-menu extension slot, so the client uses the current workspace-row and menu DOM. If a future host changes that structure, the action may disappear. It must not reorder workspaces on its own. Windows and non-empty session-menu browser behavior have not been verified.

## Verify

```sh
npm ci
npm run check
```
