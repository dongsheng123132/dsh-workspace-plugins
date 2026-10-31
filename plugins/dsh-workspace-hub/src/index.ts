/**
 * dsh-plugin-workspace-hub — seed the DSH sidebar from the wshub ledger.
 *
 * Plugin form: a configurable service plugin that also registers model tools.
 * - service: `ctx.wshubWorkspaceHub` (serialized reconciliation queue + status)
 * - tools: `workspace_hub_list`, `workspace_hub_sync`
 * - config: `ledgerPath`, `maxAdd`, `dryRun`, `intervalSeconds`
 *
 * The DSH-side write path is the official in-process API
 * `ctx.workspaceRegistry.create(path, title)` from `@deepseek-ai/dsh-workspace`
 * (row `workspace` of the web bundle); the registry canonicalizes with
 * `fs.realpath`, so creation is idempotent by canonical path.
 * @module dsh-plugin-workspace-hub
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config as WorkspaceHubConfig } from './config.js'
import { Config as WorkspaceHubConfigSchema } from './config.js'
import { WorkspaceHubService } from './service.js'

/** Stable plugin module name (matches `pluginNames` in `dsh-plugin.naming.json`). */
export const name = 'workspace-hub'

/** Services that must exist before this plugin loads; `ctx.tools` is then ready inside `apply`. */
export const inject = ['tools', 'workspaceRegistry']

/** Configuration schema read by the Loader from the profile patch row. */
export const Config = WorkspaceHubConfigSchema

/** Validated configuration shape (type-only companion of {@link Config}). */
export type Config = WorkspaceHubConfig

export { WorkspaceHubService, SERVICE_NAME, LOG_LABEL } from './service.js'
export type { SyncOptions, SyncTrigger } from './service.js'
export { SKIP_REASONS, SKIP_REASON_TEXT } from './plan.js'
export type { SkipReason, SkippedEntry, SyncCandidate, SyncPlan } from './plan.js'
export { LEDGER_STATES, defaultLedgerPath, readLedger } from './ledger.js'
export type { LedgerEntry, LedgerSnapshot, LedgerState } from './ledger.js'
export type { AddedEntry, FailedEntry, SyncResult, WorkspaceRegistryPort } from './sync.js'
export { buildListView, formatListText, formatSyncText } from './format.js'
export type { EntryState, ListEntryView, ListView } from './format.js'

/**
 * Create the service (which registers the tools) and run the activation pass.
 *
 * Resolving after the activation pass settles makes the Loader's `apply` gate
 * meaningful: the sidebar is populated without a session, and a broken ledger
 * is reported through the service instead of failing the composition.
 * @param ctx plugin context, injected with `tools` and `workspaceRegistry`
 * @param config validated configuration
 * @returns resolution after the activation sync settled
 */
export async function apply(ctx: Context, config: WorkspaceHubConfig): Promise<void> {
  const hub = new WorkspaceHubService(ctx, config)
  await hub.start()
}
