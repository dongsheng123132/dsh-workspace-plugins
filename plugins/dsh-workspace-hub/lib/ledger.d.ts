/** Every read outcome, in declaration order; the model-facing Schema reuses this list. */
export declare const LEDGER_STATES: readonly ["ok", "missing", "invalid-json", "invalid-shape", "read-error"];
/** Outcome of reading the ledger file; every non-`ok` state is reported, never thrown. */
export type LedgerState = (typeof LEDGER_STATES)[number];
/**
 * One raw ledger workspace record.
 *
 * Only the fields this plugin consumes are typed. Everything stays optional:
 * the file belongs to another tool, so an older or newer schema must degrade
 * into a reported skip instead of crashing the Host.
 */
export interface LedgerEntry {
    readonly path?: unknown;
    readonly displayName?: unknown;
    readonly kind?: unknown;
    readonly pinned?: unknown;
    readonly lastActiveAt?: unknown;
    readonly presentIn?: unknown;
}
/** One read of the ledger, including the failure state the model will see. */
export interface LedgerSnapshot {
    /** Absolute path the plugin tried to read. */
    readonly ledgerPath: string;
    /** Parse/read outcome. */
    readonly state: LedgerState;
    /** Actionable explanation for a non-`ok` state; absent when `ok`. */
    readonly message?: string;
    /** Ledger's own `updatedAt`, when it carries a string. */
    readonly updatedAt?: string;
    /** Raw workspace records in ledger order; empty unless `state === 'ok'`. */
    readonly entries: LedgerEntry[];
}
/** Expand a leading `~` or `~/` without resolving symlinks. */
export declare function expandHomePath(input: string): string;
/**
 * Default ledger location, mirroring the wshub CLI's own resolution order:
 * `$WSHUB_HOME/ledger.json`, then `$WDHUB_HOME/ledger.json`, then
 * `~/.workspace-hub/ledger.json`.
 * @returns absolute ledger path
 */
export declare function defaultLedgerPath(): string;
/**
 * Read and shape-check the ledger file. Never throws for a missing or broken
 * ledger: the Host must stay usable, so the failure is returned as data and
 * surfaced by `workspace_hub_list` / `workspace_hub_sync`.
 * @param ledgerPath absolute or `~`-prefixed ledger path
 * @returns the snapshot including its state
 */
export declare function readLedger(ledgerPath: string): Promise<LedgerSnapshot>;
