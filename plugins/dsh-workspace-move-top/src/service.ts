import { Service, type Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

export const SERVICE_NAME = 'wshubWorkspaceMoveTop'
declare module '@deepseek-ai/cordis' {
  interface Context { wshubWorkspaceMoveTop: WorkspaceMoveTopService }
}

/** Registry projection needed for ordering and the route payload. */
export interface WorkspaceEntryView {
  readonly id: string
  readonly path: string
  readonly title: string
}

/** One successful move-to-top result. */
export interface MoveToTopResult {
  readonly ok: true
  /** Whether an `insertBefore` actually moved the workspace. */
  readonly moved: boolean
  /** The complete durable order after the operation (top first). */
  readonly order: readonly string[]
  readonly workspaces: readonly WorkspaceEntryView[]
}

/** Failure result for an empty registry or an unknown workspace. */
export interface MoveToTopError {
  readonly ok: false
  readonly reason: 'none'
  readonly message: string
}

function toEntryView(entry: { readonly id: unknown; readonly path: string; readonly title: string }): WorkspaceEntryView {
  return { id: String(entry.id), path: entry.path, title: entry.title }
}

/** Stateless "move to top" service. Owns the registry ordering queue but no
 * file or saved state: it never reorders on activation and keeps no ordering
 * or favorites state. */
export class WorkspaceMoveTopService extends Service {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME)
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
  private list(): readonly WorkspaceEntryView[] {
    return this.ctx.workspaceRegistry.list().map(toEntryView)
  }
  /** Move one workspace to the top of the durable display order, exactly once.
   *
   * Reads the real registry order; an already-first workspace is a no-op and an
   * unknown workspace is rejected without touching the order. Otherwise it asks
   * the host for `insertBefore(id, firstId)` — the same durable write the
   * official sidebar drag uses — so the result survives restart and no plugin
   * startup pass re-applies it.
   * @param workspaceId exact registry ID
   */
  moveToTop(workspaceId: string): Promise<MoveToTopResult | MoveToTopError> {
    return this.enqueue(async () => {
      const registry = this.ctx.workspaceRegistry
      const order = registry.list()
      const first = order[0]
      if (first === undefined) return { ok: false, reason: 'none', message: '工作区列表为空' }
      if (first.id === workspaceId) {
        return { ok: true, moved: false, order: order.map(entry => String(entry.id)), workspaces: order.map(toEntryView) }
      }
      if (!order.some(entry => entry.id === workspaceId)) {
        return { ok: false, reason: 'none', message: '工作区已不存在，请刷新列表' }
      }
      const next = await registry.insertBefore(workspaceId as WorkspaceId, first.id)
      return { ok: true, moved: true, order: next.map(id => String(id)), workspaces: this.list() }
    })
  }
}
