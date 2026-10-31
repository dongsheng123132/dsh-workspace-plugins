import type { Context } from '@deepseek-ai/cordis';
export declare const name = "workspace-move-top";
export declare const inject: string[];
export { WorkspaceMoveTopService, SERVICE_NAME } from './service.js';
export { MOVE_ROUTE, handleMoveRequest } from './move-route.js';
/** Activate the stateless move-to-top service. No startup reordering: the
 * host's durable registry order is left untouched until a client asks to move
 * one workspace to the top.
 * @param ctx injected plugin scope
 */
export declare function apply(ctx: Context): Promise<void>;
