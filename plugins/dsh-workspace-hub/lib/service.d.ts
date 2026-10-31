import { Service, type Context } from '@deepseek-ai/cordis';
import { type Config, type ResolvedConfig } from './config.js';
import { type ListView } from './format.js';
import { type LedgerSnapshot } from './ledger.js';
import { type SyncPlan } from './plan.js';
import { type SyncResult } from './sync.js';
import { type ScanResult } from './scan.js';
/** Cordis service key other plugins use: `ctx.wshubWorkspaceHub`. */
export declare const SERVICE_NAME = "wshubWorkspaceHub";
/** Logger/plugin label; keep it aligned with the module name in `dsh-plugin.naming.json`. */
export declare const LOG_LABEL = "workspace-hub";
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The workspace-hub synchronization service. */
        wshubWorkspaceHub: WorkspaceHubService;
    }
}
/** Why a pass ran; recorded for diagnostics only. */
export type SyncTrigger = 'startup' | 'tool' | 'interval';
/** Steps reported by `wshub auto --json`. */
export interface AutoSyncSteps {
    readonly repo?: string | null;
    readonly pull?: {
        ok?: boolean;
        workspaces?: number | null;
        error?: string | null;
    } | null;
    readonly scan?: {
        ok?: boolean;
        total?: number | null;
        adapters?: number | null;
    } | null;
    readonly push?: {
        ok?: boolean;
        committed?: boolean;
        error?: string | null;
    } | null;
}
/** Outcome of one {@link WorkspaceHubService.autoSync} pass. */
export interface AutoSyncResult {
    readonly ok: boolean;
    readonly error?: string;
    readonly steps?: AutoSyncSteps;
}
/** Options accepted by {@link WorkspaceHubService.sync}. */
export interface SyncOptions {
    /** Override the configured dry-run flag for this pass. */
    readonly dryRun?: boolean | undefined;
    /** Override `maxAdd` for this pass (`0` = unlimited). */
    readonly maxAdd?: number | undefined;
    /** Cancellation from the calling tool; checked between creates. */
    readonly signal?: AbortSignal | undefined;
    /** What started this pass. */
    readonly trigger?: SyncTrigger | undefined;
}
/**
 * Owns the ledger → DSH workspace reconciliation.
 *
 * Registration is a Cordis effect: tools, the interval timer, and the service
 * key are all removed when the plugin unloads or its configuration hot-replaces.
 */
export declare class WorkspaceHubService extends Service {
    /** Resolved configuration used by this instance. */
    readonly config: ResolvedConfig;
    private queue;
    private lastSync;
    private lastScan;
    private lastAuto;
    private lastError;
    /**
     * @param ctx plugin context (already injected with `tools` and `workspaceRegistry`)
     * @param config validated user configuration
     */
    constructor(ctx: Context, config: Config);
    /** Registrations currently in the DSH workspace registry. */
    private registryPort;
    /** Read the ledger without touching the registry. */
    private readLedgerOnce;
    /** Build a plan against the registry's current canonical paths. */
    private buildPlan;
    /**
     * Describe what the ledger holds and what the DSH list is missing.
     * Read-only: never creates, renames, or deletes a workspace.
     * @returns the canonical list value, including the last sync instant
     */
    inspect(): Promise<ListView>;
    /**
     * Execute one reconciliation pass. Passes are serialized: a second call waits
     * for the running one, so concurrent tool calls cannot double-create.
     * @param options per-pass overrides, cancellation, and trigger label
     * @returns the canonical sync result
     */
    sync(options?: SyncOptions): Promise<SyncResult>;
    /** The most recent pass, when one has run. */
    get lastSyncResult(): SyncResult | undefined;
    /** The most recent pre-sync scan attempt, when one has run. */
    get lastScanResult(): ScanResult | undefined;
    /**
     * Best-effort `wshub scan --save` so the ledger is fresh before reconciliation.
     * @returns scan outcome (never throws)
     */
    private scanOnce;
    /**
     * 一次 git 同步：拉取远端账本 → 扫描本机 → 推送（调用 `wshub auto`）。
     * 未配置 `gitRepo` 时直接返回失败，不产生副作用。
     * @returns 各步骤结果；`ok` 表示拉取与推送均成功
     */
    autoSync(): Promise<AutoSyncResult>;
    /** 最近一次 git 同步结果。 */
    get lastAutoSyncResult(): AutoSyncResult | undefined;
    /**
     * Scan first, then reconcile in one serialized pass.
     * This is what makes a project created in another AI tool show up after a
     * single "刷新并同步" request, without running the CLI by hand.
     * @param options per-pass overrides and cancellation
     * @returns the scan outcome and the sync result
     */
    refresh(options?: SyncOptions): Promise<{
        scan: ScanResult;
        sync: SyncResult;
    }>;
    /** The most recent unexpected failure, when one happened. */
    get lastErrorText(): string | undefined;
    /**
     * Run the activation-time pass and, when configured, install the interval.
     * Startup failures are logged and recorded, never thrown: a broken ledger
     * must not fail the whole DSH composition.
     * @returns resolution after the activation pass settled
     */
    start(): Promise<void>;
    private performSync;
    /** Log only what an operator needs: ledger trouble, created workspaces, failures. */
    private report;
    private installInterval;
}
export type { LedgerSnapshot, ListView, SyncPlan, SyncResult };
