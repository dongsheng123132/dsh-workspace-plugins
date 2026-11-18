# Move to Top for DeepSeek Harness

> **Move Up has moved:** its current source, installation instructions and updates are at **[github.com/dongsheng123132/dsh-move-up](https://github.com/dongsheng123132/dsh-move-up)**. This repository retains the earlier source and also contains the separate Workspace Hub plugin.

**Maintainer / Author：He Fangsheng (贺方升 / 贺去病; also known as Dosen) · [hequbing.com](https://www.hequbing.com)**

One menu item that moves a workspace to the top of the DSH sidebar, once. [中文说明](README.zh-CN.md)

The same repository also carries **Workspace Hub**, which brings project directories recorded by your other AI tools into the same sidebar. The two plugins are independent; neither requires the other.

## Move to Top

**Move a workspace to the top of the sidebar once, without creating a favorites system.**

- Adds exactly one action to the workspace `…` menu.
- Behaves like a single long drag: the order is written once, and subsequent manual ordering stays yours.
- No stars, pinned categories, saved favorites, automatic reordering, or startup re-sort. If you never click the item, nothing happens.
- No runtime dependencies, saved ordering state, or background work.
- Does not require Workspace Hub.

Package: [`dsh-move-up`](https://www.npmjs.com/package/dsh-move-up)

```sh
dsh plugin --profile desktop add dsh-move-up
```

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

## Compatibility and privacy

- For the current Move Up version's compatibility, tested platforms and limitations, see its [compatibility documentation](https://github.com/dongsheng123132/dsh-move-up/blob/main/COMPATIBILITY.md).
- For the legacy code and Workspace Hub in this repository, the historical test baseline was **DSH 0.2.1-rc.5 on macOS**; consult the individual package documentation for its limitations.
- Workspace Hub reads project-directory metadata and writes a local ledger. Do not publish that ledger or your optional private Git remote.
- Packages contain no user ledger, device record, npm credentials, or local absolute paths.

See each plugin's README for exact behavior and limitations.

## License

MIT
