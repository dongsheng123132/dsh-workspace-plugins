/**
 * Execute one plan. Candidates are created in reverse ledger order because the
 * DSH registry prepends every new registration: reversing leaves the sidebar
 * top matching the ledger's own order (pinned first, then recently active).
 * One failing directory never aborts the pass; it is reported in `failed`.
 * @param registry the DSH workspace registry port
 * @param plan plan produced by `buildSyncPlan`
 * @param options dry-run flag and optional cancellation
 * @returns the canonical sync result
 */
export async function executeSyncPlan(registry, plan, options) {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const added = [];
    const failed = [];
    let aborted = false;
    for (const candidate of [...plan.candidates].reverse()) {
        if (options.signal?.aborted === true) {
            aborted = true;
            break;
        }
        if (options.dryRun) {
            added.push({ path: candidate.path, title: candidate.title });
            continue;
        }
        try {
            const workspace = await registry.create(candidate.canonicalPath, candidate.title);
            added.push({
                path: candidate.path,
                title: workspace.title,
                ...(workspace.id !== undefined ? { workspaceId: String(workspace.id) } : {}),
            });
        }
        catch (error) {
            failed.push({
                path: candidate.path,
                title: candidate.title,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    // Creating in reverse ledger order (see the loop) leaves the sidebar top in
    // ledger order; report in that same order so "newest first" reads naturally.
    added.reverse();
    failed.reverse();
    return {
        dryRun: options.dryRun,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        ledgerPath: plan.ledgerPath,
        ledgerState: plan.ledgerState,
        ...(plan.ledgerMessage !== undefined ? { ledgerMessage: plan.ledgerMessage } : {}),
        ...(plan.ledgerUpdatedAt !== undefined ? { ledgerUpdatedAt: plan.ledgerUpdatedAt } : {}),
        total: plan.total,
        alreadyPresent: plan.alreadyPresent,
        added,
        skipped: plan.skipped,
        failed,
        aborted,
        registryTotal: registry.list().length,
    };
}
