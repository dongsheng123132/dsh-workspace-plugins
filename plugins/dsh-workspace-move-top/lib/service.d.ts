import { Service, type Context } from '@deepseek-ai/cordis';
export declare const SERVICE_NAME = "wshubWorkspaceMoveTop";
declare module '@deepseek-ai/cordis' {
    interface Context {
        wshubWorkspaceMoveTop: WorkspaceMoveTopService;
    }
}
/** Registry projection needed for ordering and the route payload. */
export interface WorkspaceEntryView {
    readonly id: string;
    readonly path: string;
    readonly title: string;
}
/** One successful move-to-top result. */
export interface MoveToTopResult {
    readonly ok: true;
    /** Whether an `insertBefore` actually moved the workspace. */
    readonly moved: boolean;
    /** The complete durable order after the operation (top first). */
    readonly order: readonly string[];
    readonly workspaces: readonly WorkspaceEntryView[];
}
/** Failure result for an empty registry or an unknown workspace. */
export interface MoveToTopError {
    readonly ok: false;
    readonly reason: 'none';
    readonly message: string;
}
/** Stateless "move to top" service. Owns the registry ordering queue but no
 * file or saved state: it never reorders on activation and keeps no ordering
 * or favorites state. */
export declare class WorkspaceMoveTopService extends Service {
    private queue;
    constructor(ctx: Context);
    private enqueue;
    private list;
    /** Move one workspace to the top of the durable display order, exactly once.
     *
     * Reads the real registry order; an already-first workspace is a no-op and an
     * unknown workspace is rejected without touching the order. Otherwise it asks
     * the host for `insertBefore(id, firstId)` — the same durable write the
     * official sidebar drag uses — so the result survives restart and no plugin
     * startup pass re-applies it.
     * @param workspaceId exact registry ID
     */
    moveToTop(workspaceId: string): Promise<MoveToTopResult | MoveToTopError>;
}
