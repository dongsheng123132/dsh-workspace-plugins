import { type LedgerSnapshot, type LedgerState } from './ledger.js';
/** Every skip reason, in declaration order; the model-facing Schema reuses this list. */
export declare const SKIP_REASONS: readonly ["invalid-entry", "unsupported-kind", "invalid-path", "directory-missing", "duplicate-path", "exists-in-dsh", "max-add-limit"];
/** Why one ledger record will not be seeded into the DSH workspace list. */
export type SkipReason = (typeof SKIP_REASONS)[number];
/** One workspace the next sync would create in DSH. */
export interface SyncCandidate {
    /** Path as written in the ledger. */
    readonly path: string;
    /** `fs.realpath` canonical path; also DSH's uniqueness key. */
    readonly canonicalPath: string;
    /** Title DSH will use when it creates the workspace. */
    readonly title: string;
    /** Ledger kind; always `project` for candidates. */
    readonly kind: string;
    readonly pinned: boolean;
    /** Ledger `lastActiveAt` when it is a non-empty string. */
    readonly lastActiveAt?: string;
    /** Tools the last successful wshub scan saw this directory in. */
    readonly presentIn: string[];
}
/** One ledger record that is skipped, with a machine reason and a Chinese explanation. */
export interface SkippedEntry {
    readonly path: string;
    readonly title?: string;
    readonly reason: SkipReason;
    readonly message: string;
}
/** One ledger record DSH already owns (matched by canonical path). */
export interface PresentEntry {
    readonly path: string;
    readonly canonicalPath: string;
    readonly title: string;
}
/** Everything one planning pass knows; also the read-only half of a sync result. */
export interface SyncPlan {
    readonly ledgerPath: string;
    readonly ledgerState: LedgerState;
    readonly ledgerMessage?: string;
    readonly ledgerUpdatedAt?: string;
    /** Ledger records seen this pass. */
    readonly total: number;
    /** Records to create, in ledger order (DSH prepends each one, see `sync.ts`). */
    readonly candidates: SyncCandidate[];
    /** Records already registered in DSH. */
    readonly present: PresentEntry[];
    readonly skipped: SkippedEntry[];
    /** `present.length`, kept explicit because it is what the model reports. */
    readonly alreadyPresent: number;
}
/** Options for one planning pass. */
export interface PlanOptions {
    /** Canonical paths the DSH workspace registry already owns. */
    readonly existingPaths: Iterable<string>;
    /** Per-pass create cap; `0` means unlimited. */
    readonly maxAdd: number;
    /** Stops planning between records when the caller's tool call is cancelled. */
    readonly signal?: AbortSignal | undefined;
}
/** Chinese text for every skip reason; the machine reason stays in `reason`. */
export declare const SKIP_REASON_TEXT: Readonly<Record<SkipReason, string>>;
/**
 * Build one plan from a ledger snapshot and the registry's current paths.
 * Pure with respect to the ledger: only filesystem reads (`stat`, `realpath`).
 * @param ledger snapshot returned by `readLedger`
 * @param options existing registry paths, per-pass cap, optional cancellation
 * @returns the plan the model and the executor both consume
 */
export declare function buildSyncPlan(ledger: LedgerSnapshot, options: PlanOptions): Promise<SyncPlan>;
/** Whether a canonical path is already owned by DSH; exported for tests only. */
export declare function isOwnedByDsh(canonicalPath: string, existingPaths: Iterable<string>): boolean;
