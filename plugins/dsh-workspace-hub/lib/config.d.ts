/**
 * Configuration schema for dsh-plugin-workspace-hub.
 *
 * Every tunable value is a `Config` field settable from the profile's
 * `cordis.patch.yml`; invalid values fail plugin loading during Schema
 * validation instead of being silently coerced.
 * @module dsh-plugin-workspace-hub/config
 */
import Schema from '@deepseek-ai/schemastery';
/** User-settable configuration (validated by the Loader before `apply` runs). */
export interface Config {
    /** Ledger JSON path; `~` is expanded. Defaults to `$WSHUB_HOME/ledger.json` or `~/.workspace-hub/ledger.json`. */
    ledgerPath: string;
    /** Maximum workspaces created by one pass; `0` means unlimited. */
    maxAdd: number;
    /** Plan-only mode: nothing is written to the DSH registry. */
    dryRun: boolean;
    /** Background resync interval in seconds; `0` disables the timer. */
    intervalSeconds: number;
    /** Run `wshub scan --save` before the activation pass, so newly created projects are picked up. */
    scanOnStart: boolean;
    /** Path to `hub/wdhub.mjs`; empty string prefers the bundled CLI. */
    hubCliPath: string;
    /** Hard timeout for the pre-sync scan, in milliseconds. */
    scanTimeoutMs: number;
    /** GitHub (or any git) private repo used as the ledger sync remote; empty disables git sync. */
    gitRepo: string;
    /** Run the git pull → scan → push pass on plugin activation. */
    gitSyncOnStart: boolean;
    /** Hard timeout for the git sync pass, in milliseconds. */
    gitTimeoutMs: number;
}
/** Schemastery schema exported as the plugin's `Config` (Standard Schema compatible). */
export declare const Config: Schema<Config>;
/** Configuration after resolution: `ledgerPath` is absolute. */
export type ResolvedConfig = Config;
/**
 * Resolve user configuration into the values the runtime uses.
 * Kept as an explicit step so defaults never hide inside `sync()`.
 * @param config validated user configuration
 * @returns configuration with absolute ledger path
 */
export declare function resolveConfig(config: Config): ResolvedConfig;
