/**
 * Execute a sync plan against the DSH workspace registry.
 *
 * The registry port is deliberately narrow: `list()` + `create(path, title)`.
 * Both come straight from `ctx.workspaceRegistry`; the service adapts it so this
 * module stays unit-testable without a Cordis context.
 * @module dsh-plugin-workspace-hub/sync
 */
import type { LedgerState } from './ledger.js'
import type { SkippedEntry, SyncPlan } from './plan.js'

/** The slice of `ctx.workspaceRegistry` this plugin needs. */
export interface WorkspaceRegistryPort {
  /** Current registrations in durable sidebar order (top first). */
  list(): readonly { readonly id?: unknown; readonly path: string; readonly title: string }[]
  /** Create or reuse one registration for an existing directory. */
  create(
    path: string,
    title?: string,
  ): Promise<{ readonly id?: unknown; readonly path: string; readonly title: string }>

}

/** One workspace this run created (or would create, in a dry run). */
export interface AddedEntry {
  readonly path: string
  readonly title: string
  /** Registry id; absent in a dry run. */
  readonly workspaceId?: string
}

/** One registry failure; the pass continues with the remaining candidates. */
export interface FailedEntry {
  readonly path: string
  readonly title: string
  readonly error: string
}

/** Canonical result of one sync pass: everything the model needs to rebuild what happened. */
export interface SyncResult {
  /** True when the pass only planned. */
  readonly dryRun: boolean
  /** ISO-8601 instant the pass started. */
  readonly startedAt: string
  readonly durationMs: number
  readonly ledgerPath: string
  readonly ledgerState: LedgerState
  readonly ledgerMessage?: string
  readonly ledgerUpdatedAt?: string
  /** Ledger records seen this pass. */
  readonly total: number
  /** Records the registry already owned before this pass. */
  readonly alreadyPresent: number
  readonly added: AddedEntry[]
  readonly skipped: SkippedEntry[]
  readonly failed: FailedEntry[]
  /** Set when the caller's signal aborted the pass between creates. */
  readonly aborted: boolean
  /** Registrations in the registry after this pass. */
  readonly registryTotal: number
}

/** Options for one execution. */
export interface ExecuteOptions {
  readonly dryRun: boolean
  /** Cancels between creates; already-created registrations stay (the registry is durable). */
  readonly signal?: AbortSignal | undefined
}

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
export async function executeSyncPlan(
  registry: WorkspaceRegistryPort,
  plan: SyncPlan,
  options: ExecuteOptions,
): Promise<SyncResult> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const added: AddedEntry[] = []
  const failed: FailedEntry[] = []
  let aborted = false

  for (const candidate of [...plan.candidates].reverse()) {
    if (options.signal?.aborted === true) {
      aborted = true
      break
    }
    if (options.dryRun) {
      added.push({ path: candidate.path, title: candidate.title })
      continue
    }
    try {
      const workspace = await registry.create(candidate.canonicalPath, candidate.title)
      added.push({
        path: candidate.path,
        title: workspace.title,
        ...(workspace.id !== undefined ? { workspaceId: String(workspace.id) } : {}),
      })
    } catch (error) {
      failed.push({
        path: candidate.path,
        title: candidate.title,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Creating in reverse ledger order (see the loop) leaves the sidebar top in
  // ledger order; report in that same order so "newest first" reads naturally.
  added.reverse()
  failed.reverse()

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
  }
}
