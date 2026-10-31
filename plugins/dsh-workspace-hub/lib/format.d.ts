/**
 * Chinese-friendly, replayable projections of the sync plan and sync result.
 *
 * These functions are pure: they depend only on their argument values, so the
 * same text can be rebuilt from the session log during replay.
 * @module dsh-plugin-workspace-hub/format
 */
import type { LedgerState } from './ledger.js';
import { type SkipReason, type SyncPlan } from './plan.js';
import type { SyncResult } from './sync.js';
/** How one ledger record currently relates to the DSH workspace list. */
export type EntryState = 'in-dsh' | 'candidate' | 'skipped';
/** One model-visible ledger row of `workspace_hub_list`. */
export interface ListEntryView {
    readonly path: string;
    readonly title: string;
    readonly kind: string;
    readonly pinned: boolean;
    readonly lastActiveAt?: string;
    readonly presentIn: string[];
    readonly state: EntryState;
    readonly reason?: SkipReason;
    readonly message?: string;
}
/** Canonical value of the `workspace_hub_list` tool. */
export interface ListView {
    readonly ledgerPath: string;
    readonly ledgerState: LedgerState;
    readonly ledgerMessage?: string;
    readonly ledgerUpdatedAt?: string;
    readonly total: number;
    readonly inDsh: number;
    readonly candidates: number;
    readonly skipped: number;
    readonly registryTotal: number;
    readonly maxAdd: number;
    readonly dryRun: boolean;
    readonly lastSyncAt?: string;
    readonly entries: ListEntryView[];
}
/** Everything the list projection needs beyond the plan itself. */
export interface ListViewExtras {
    readonly registryTotal: number;
    readonly maxAdd: number;
    readonly dryRun: boolean;
    readonly lastSyncAt?: string;
}
/**
 * Join a plan with live registry facts into the model-visible list value.
 * @param plan plan built from the current ledger
 * @param extras registry size, effective config, and last sync instant
 * @returns the canonical list view
 */
export declare function buildListView(plan: SyncPlan, extras: ListViewExtras): ListView;
/**
 * Render the list value as compact Chinese text: counts first, then one line
 * per ledger record grouped by state.
 * @param view the canonical list value
 * @returns model-visible text
 */
export declare function formatListText(view: ListView): string;
/**
 * Render a sync result as Chinese text: what was created, what was already
 * there, what was skipped and what failed.
 * @param result the canonical sync result value
 * @returns model-visible text
 */
export declare function formatSyncText(result: SyncResult): string;
