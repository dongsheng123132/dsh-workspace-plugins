/**
 * The `wshubWorkspaceHub` service and the two model-callable tools.
 *
 * The service is the single owner of reconciliation: activation, the optional
 * interval, and `workspace_hub_sync` all funnel through one serialized queue so
 * two passes can never plan against the same registry snapshot and double-add.
 * @module dsh-plugin-workspace-hub/service
 */
import path from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import { resolveConfig, type Config, type ResolvedConfig } from './config.js'
import { buildListView, type ListView } from './format.js'
import { readLedger, type LedgerSnapshot } from './ledger.js'
import { buildSyncPlan, type SyncPlan } from './plan.js'
import { executeSyncPlan, type SyncResult, type WorkspaceRegistryPort } from './sync.js'
import { defaultHubCliPath, runHubCommand, runHubScan, type ScanResult } from './scan.js'
import { createWorkspaceHubTools } from './tools.js'

/** Cordis service key other plugins use: `ctx.wshubWorkspaceHub`. */
export const SERVICE_NAME = 'wshubWorkspaceHub'

/** Logger/plugin label; keep it aligned with the module name in `dsh-plugin.naming.json`. */
export const LOG_LABEL = 'workspace-hub'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The workspace-hub synchronization service. */
    wshubWorkspaceHub: WorkspaceHubService
  }
}

/** Why a pass ran; recorded for diagnostics only. */
export type SyncTrigger = 'startup' | 'tool' | 'interval'

/** Steps reported by `wshub auto --json`. */
export interface AutoSyncSteps {
  readonly repo?: string | null
  readonly pull?: { ok?: boolean; workspaces?: number | null; error?: string | null } | null
  readonly scan?: { ok?: boolean; total?: number | null; adapters?: number | null } | null
  readonly push?: { ok?: boolean; committed?: boolean; error?: string | null } | null
}

/** Outcome of one {@link WorkspaceHubService.autoSync} pass. */
export interface AutoSyncResult {
  readonly ok: boolean
  readonly error?: string
  readonly steps?: AutoSyncSteps
}

/** Options accepted by {@link WorkspaceHubService.sync}. */
export interface SyncOptions {
  /** Override the configured dry-run flag for this pass. */
  readonly dryRun?: boolean | undefined
  /** Override `maxAdd` for this pass (`0` = unlimited). */
  readonly maxAdd?: number | undefined
  /** Cancellation from the calling tool; checked between creates. */
  readonly signal?: AbortSignal | undefined
  /** What started this pass. */
  readonly trigger?: SyncTrigger | undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Clamp a per-call `maxAdd` override; `0` and anything unusable means "unlimited". */
function normalizeMaxAdd(value: number, fallback: number): number {
  const requested = Number.isFinite(value) ? value : fallback
  return Math.max(0, Math.trunc(requested))
}

/**
 * Owns the ledger → DSH workspace reconciliation.
 *
 * Registration is a Cordis effect: tools, the interval timer, and the service
 * key are all removed when the plugin unloads or its configuration hot-replaces.
 */
export class WorkspaceHubService extends Service {
  /** Resolved configuration used by this instance. */
  readonly config: ResolvedConfig

  private queue: Promise<unknown> = Promise.resolve()
  private lastSync: SyncResult | undefined
  private lastScan: ScanResult | undefined
  private lastAuto: AutoSyncResult | undefined
  private lastError: string | undefined

  /**
   * @param ctx plugin context (already injected with `tools` and `workspaceRegistry`)
   * @param config validated user configuration
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, SERVICE_NAME)
    this.config = resolveConfig(config)
    for (const tool of createWorkspaceHubTools(this)) this.ctx.tools.register(tool)
    if (this.config.intervalSeconds > 0) this.installInterval(this.config.intervalSeconds)
  }

  /** Registrations currently in the DSH workspace registry. */
  private registryPort(): WorkspaceRegistryPort {
    const registry = this.ctx.workspaceRegistry
    return {
      list: () => registry.list(),
      create: (path, title) => registry.create(path, title),
    }
  }

  /** Read the ledger without touching the registry. */
  private async readLedgerOnce(): Promise<LedgerSnapshot> {
    return await readLedger(this.config.ledgerPath)
  }

  /** Build a plan against the registry's current canonical paths. */
  private async buildPlan(ledger: LedgerSnapshot, options: { maxAdd: number; signal?: AbortSignal | undefined }): Promise<SyncPlan> {
    return await buildSyncPlan(ledger, {
      existingPaths: this.ctx.workspaceRegistry.list().map((workspace) => workspace.path),
      maxAdd: options.maxAdd,
      signal: options.signal,
    })
  }

  /**
   * Describe what the ledger holds and what the DSH list is missing.
   * Read-only: never creates, renames, or deletes a workspace.
   * @returns the canonical list value, including the last sync instant
   */
  async inspect(): Promise<ListView> {
    const ledger = await this.readLedgerOnce()
    const plan = await this.buildPlan(ledger, { maxAdd: this.config.maxAdd })
    return buildListView(plan, {
      registryTotal: this.ctx.workspaceRegistry.list().length,
      maxAdd: this.config.maxAdd,
      dryRun: this.config.dryRun,
      ...(this.lastSync !== undefined ? { lastSyncAt: this.lastSync.startedAt } : {}),
    })
  }

  /**
   * Execute one reconciliation pass. Passes are serialized: a second call waits
   * for the running one, so concurrent tool calls cannot double-create.
   * @param options per-pass overrides, cancellation, and trigger label
   * @returns the canonical sync result
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const run = this.queue.then(async () => await this.performSync(options))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  /** The most recent pass, when one has run. */
  get lastSyncResult(): SyncResult | undefined {
    return this.lastSync
  }

  /** The most recent pre-sync scan attempt, when one has run. */
  get lastScanResult(): ScanResult | undefined {
    return this.lastScan
  }

  /**
   * Best-effort `wshub scan --save` so the ledger is fresh before reconciliation.
   * @returns scan outcome (never throws)
   */
  private async scanOnce(): Promise<ScanResult> {
    const cliPath = this.config.hubCliPath || defaultHubCliPath()
    const result = await runHubScan({
      cliPath,
      ledgerPath: this.config.ledgerPath,
      timeoutMs: this.config.scanTimeoutMs,
    })
    this.lastScan = result
    if (!result.ok) {
      this.ctx.logger(LOG_LABEL).warn('pre-sync scan %s: %s', result.skipped ? 'skipped' : 'failed', result.message ?? 'no detail')
    }
    return result
  }

  /**
   * 一次 git 同步：拉取远端账本 → 扫描本机 → 推送（调用 `wshub auto`）。
   * 未配置 `gitRepo` 时直接返回失败，不产生副作用。
   * @returns 各步骤结果；`ok` 表示拉取与推送均成功
   */
  async autoSync(): Promise<AutoSyncResult> {
    if (!this.config.gitRepo) return { ok: false, error: '未配置 gitRepo（gitRepo 为空）' }
    const cliPath = this.config.hubCliPath || defaultHubCliPath()
    const home = path.dirname(this.config.ledgerPath)
    const run = await runHubCommand({
      cliPath,
      args: ['auto', '--repo', this.config.gitRepo, '--home', home, '--json'],
      timeoutMs: this.config.gitTimeoutMs,
    })
    let steps: AutoSyncSteps | undefined
    try {
      const line = run.stdout.trim().split('\n').filter(Boolean).pop() || '{}'
      steps = JSON.parse(line) as AutoSyncSteps
    } catch {
      steps = undefined
    }
    const result: AutoSyncResult = {
      ok: run.ok && steps?.pull?.ok !== false,
      ...(run.ok ? {} : { error: run.message ?? `wshub auto 退出码 ${run.exitCode ?? '?'}` }),
      ...(steps ? { steps } : {}),
    }
    this.lastAuto = result
    if (!result.ok) this.ctx.logger(LOG_LABEL).warn('git sync failed: %s', result.error ?? 'unknown')
    return result
  }

  /** 最近一次 git 同步结果。 */
  get lastAutoSyncResult(): AutoSyncResult | undefined {
    return this.lastAuto
  }

  /**
   * Scan first, then reconcile in one serialized pass.
   * This is what makes a project created in another AI tool show up after a
   * single "刷新并同步" request, without running the CLI by hand.
   * @param options per-pass overrides and cancellation
   * @returns the scan outcome and the sync result
   */
  async refresh(options: SyncOptions = {}): Promise<{ scan: ScanResult; sync: SyncResult }> {
    const run = this.queue.then(async () => {
      const scan = await this.scanOnce()
      const sync = await this.performSync(options)
      return { scan, sync }
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  /** The most recent unexpected failure, when one happened. */
  get lastErrorText(): string | undefined {
    return this.lastError
  }

  /**
   * Run the activation-time pass and, when configured, install the interval.
   * Startup failures are logged and recorded, never thrown: a broken ledger
   * must not fail the whole DSH composition.
   * @returns resolution after the activation pass settled
   */
  async start(): Promise<void> {
    try {
      if (this.config.gitSyncOnStart && this.config.gitRepo) {
        const auto = await this.autoSync()
        if (!auto.ok) this.ctx.logger(LOG_LABEL).warn('startup git sync failed: %s', auto.error ?? 'unknown')
      } else if (this.config.scanOnStart) {
        await this.scanOnce()
      }
      const result = await this.sync({ trigger: 'startup' })
      this.report(result, 'startup')
    } catch (error) {
      this.lastError = describeError(error)
      this.ctx.logger(LOG_LABEL).warn('activation sync failed: %s', this.lastError)
    }
  }

  private async performSync(options: SyncOptions): Promise<SyncResult> {
    const dryRun = options.dryRun ?? this.config.dryRun
    const maxAdd = normalizeMaxAdd(options.maxAdd ?? this.config.maxAdd, this.config.maxAdd)
    const ledger = await this.readLedgerOnce()
    const plan = await this.buildPlan(ledger, { maxAdd, signal: options.signal })
    const result = await executeSyncPlan(this.registryPort(), plan, {
      dryRun,
      signal: options.signal,
    })
    this.lastSync = result
    this.lastError = undefined
    this.report(result, options.trigger ?? 'tool')
    return result
  }

  /** Log only what an operator needs: ledger trouble, created workspaces, failures. */
  private report(result: SyncResult, trigger: SyncTrigger): void {
    const logger = this.ctx.logger(LOG_LABEL)
    if (result.ledgerState !== 'ok') {
      logger.warn('%s sync: ledger %s (%s)', trigger, result.ledgerState, result.ledgerMessage ?? 'no detail')
      return
    }
    if (result.failed.length > 0) {
      logger.warn('%s sync: %d workspace(s) failed to register', trigger, result.failed.length)
    }
    if (result.added.length > 0 || result.failed.length > 0) {
      logger.info(
        '%s sync: added %d, already present %d, skipped %d, failed %d, registry %d',
        trigger,
        result.added.length,
        result.alreadyPresent,
        result.skipped.length,
        result.failed.length,
        result.registryTotal,
      )
    }
  }

  private installInterval(seconds: number): void {
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        void this.sync({ trigger: 'interval' }).catch((error: unknown) => {
          this.lastError = describeError(error)
          this.ctx.logger(LOG_LABEL).warn('interval sync failed: %s', this.lastError)
        })
      }, seconds * 1000)
      return () => clearInterval(timer)
    }, 'wshub-workspace-hub.interval')
  }
}

export type { LedgerSnapshot, ListView, SyncPlan, SyncResult }
