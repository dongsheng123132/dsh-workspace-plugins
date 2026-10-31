import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceMoveTopService } from './service.js'
import { installMoveRoute } from './move-route.js'

export const name = 'workspace-move-top'
export const inject = ['workspaceRegistry']
export { WorkspaceMoveTopService, SERVICE_NAME } from './service.js'
export { MOVE_ROUTE, handleMoveRequest } from './move-route.js'

/** Activate the stateless move-to-top service. No startup reordering: the
 * host's durable registry order is left untouched until a client asks to move
 * one workspace to the top.
 * @param ctx injected plugin scope
 */
export async function apply(ctx: Context): Promise<void> {
  const moveTop = new WorkspaceMoveTopService(ctx)
  installMoveRoute(ctx, moveTop)
}
