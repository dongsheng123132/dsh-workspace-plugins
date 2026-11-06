# Workspace plugins for DeepSeek Harness

**Maintainer / Author：贺去病 (He Fangsheng / Dosen) · [hequbing.com](https://www.hequbing.com)**

Two small, independent plugins for the DSH sidebar. [中文说明](README.zh-CN.md)

## Workspace Hub

**Bring project directories recorded by your other AI tools into the DSH sidebar.**

- Scans supported local AI tools and maintains a local workspace ledger.
- Adds existing project directories to DSH through the official workspace registry.
- Preserves existing workspace titles and never deletes your project files.
- Includes the scanner, so no separate CLI installation is required.
- Optional Git transport is off by default. It does not copy DSH configuration, credentials, or project contents.

Package: [`dsh-plugin-workspace-hub`](https://www.npmjs.com/package/dsh-plugin-workspace-hub)

```sh
dsh plugin --profile desktop add dsh-plugin-workspace-hub@0.3.6
```

## Move to Top

**Move a workspace to the top of the sidebar once, without creating a favorites system.**

- Adds one action to the workspace `…` menu.
- Behaves like a single long drag; subsequent manual ordering stays yours.
- No stars, pinned categories, automatic reordering, or saved favorites.
- Does not require Workspace Hub.

Package: [`dsh-plugin-workspace-move-top`](https://www.npmjs.com/package/dsh-plugin-workspace-move-top)

```sh
dsh plugin --profile desktop add dsh-plugin-workspace-move-top@0.2.1
```

## Compatibility and privacy

- Tested with **DSH 0.2.1-rc.5 on macOS**. Peer dependencies target that host version.
- Windows support paths are retained, but a real Windows machine has not been verified.
- Workspace Hub reads project-directory metadata and writes a local ledger. Do not publish that ledger or your optional private Git remote.
- Move to Top uses the current workspace menu DOM because the host has no workspace-menu extension slot. A host UI change may hide the action; it must not reorder workspaces on its own.
- Packages contain no user ledger, device record, npm credentials, or local absolute paths.

See each plugin's README for exact behavior and limitations.

## License

MIT
