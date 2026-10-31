import { Config as WorkspaceHubConfigSchema } from './config.js';
import { WorkspaceHubService } from './service.js';
/** Stable plugin module name (matches `pluginNames` in `dsh-plugin.naming.json`). */
export const name = 'workspace-hub';
/** Services that must exist before this plugin loads; `ctx.tools` is then ready inside `apply`. */
export const inject = ['tools', 'workspaceRegistry'];
/** Configuration schema read by the Loader from the profile patch row. */
export const Config = WorkspaceHubConfigSchema;
export { WorkspaceHubService, SERVICE_NAME, LOG_LABEL } from './service.js';
export { SKIP_REASONS, SKIP_REASON_TEXT } from './plan.js';
export { LEDGER_STATES, defaultLedgerPath, readLedger } from './ledger.js';
export { buildListView, formatListText, formatSyncText } from './format.js';
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
export async function apply(ctx, config) {
    const hub = new WorkspaceHubService(ctx, config);
    await hub.start();
}
