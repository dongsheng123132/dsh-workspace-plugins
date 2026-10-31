import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceMoveTopService } from './service.js';
/** Exact connection route the client calls for a one-shot move. */
export declare const MOVE_ROUTE = "/api/plugins/wshub-workspace-move-top/move";
export declare const MOVE_ACTION = "move-to-top";
/** Handle an authenticated request.
 * @param moveTop serialized service
 * @param request owner authenticated request
 * @returns JSON response
 */
export declare function handleMoveRequest(moveTop: WorkspaceMoveTopService, request: Request): Promise<Response>;
/** Register the optional connection route with an effect disposer.
 * @param ctx plugin context
 * @param moveTop serialized service
 * @returns nothing
 */
export declare function installMoveRoute(ctx: Context, moveTop: WorkspaceMoveTopService): void;
