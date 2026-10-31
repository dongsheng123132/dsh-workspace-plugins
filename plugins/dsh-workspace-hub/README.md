# Workspace Hub

[中文说明](README.zh-CN.md)

Bring project directories recorded by Claude Code, Codex, Cursor, Trae, WorkBuddy, and other supported AI tools into the DSH sidebar. The package includes its scanner; no repository checkout or separate CLI installation is required.

## Install

```sh
dsh plugin --profile desktop add dsh-plugin-workspace-hub@0.3.6
```

Requires **DSH 0.2.1-rc.5**. Its DSH peer dependencies target that exact host version.

## Default behavior

On activation, the plugin scans supported local tools, saves a local ledger, and adds existing project directories through the official `workspaceRegistry.create()` API. It deduplicates canonical paths, preserves existing titles, and does not delete project files or workspaces.

Configuration is available on the `wshub-workspace-hub` profile row:

| Setting | Default | Meaning |
|---|---:|---|
| `maxAdd` | `30` | Maximum workspaces added per pass; `0` means unlimited |
| `dryRun` | `false` | Plan DSH additions without writing the registry; startup scanning still writes the ledger |
| `scanOnStart` | `true` | Scan and save the ledger when the plugin activates |
| `intervalSeconds` | `0` | Disable periodic sync; nonzero syncs the existing ledger but does not rescan tools |
| `hubCliPath` | `''` | Prefer the bundled scanner; optionally specify another CLI |
| `gitRepo` | `''` | Optional private Git transport; disabled by default |
| `gitSyncOnStart` | `false` | Do not pull, scan, and push through Git on activation |

The default ledger is `$WSHUB_HOME/ledger.json`, `$WDHUB_HOME/ledger.json`, or `~/.workspace-hub/ledger.json`.

## Tools

- `workspace_hub_list`: inspect ledger entries and sync candidates.
- `workspace_hub_sync({ dryRun?, maxAdd? })`: add entries from the existing ledger without rescanning.
- `workspace_hub_refresh({ dryRun?, maxAdd? })`: scan, save the ledger, then synchronize.
- `workspace_hub_remote_sync()`: explicitly pull, scan, push, and synchronize when a private Git remote is configured.

## Privacy and boundaries

- Scanning reads directory metadata and writes a local ledger. It does not copy project contents, DSH configuration, sessions, or credentials.
- Do not publish the ledger or optional Git remote; they may contain project names, paths, and device metadata.
- Git transport is off by default. A failed pull stops with an error and preserves local state; it does not hard-reset the repository.
- Missing directories and app-managed temporary directories are skipped. Existing workspaces are not renamed or removed automatically.
- An interval sync does not discover new external projects until the next activation or explicit refresh.

The bundled CLI retains advanced commands for compatibility. Setup, integration writes, prune, open, adopt, remove, and Git commands can have side effects; they are not part of the default plugin path and the complete repository's setup resources are not included.

## Verification and support

```sh
npm ci
npm run check
npm pack --dry-run
```

Tests include real Cordis composition, isolated pack-consumer scanning, and a Git conflict fixture proving local commits survive a failed pull. The scanner was verified after installing the packaged artifact without the source repository.

Validated on **macOS with DSH 0.2.1-rc.5**. Windows path branches are retained, but a real Windows machine and the optional Git network flow have not been verified. External AI tools may change their private storage formats; support is limited to the bundled adapters.
