/** Exact connection route the client calls for a one-shot move. */
export const MOVE_ROUTE = '/api/plugins/wshub-workspace-move-top/move';
export const MOVE_ACTION = 'move-to-top';
/** Handle an authenticated request.
 * @param moveTop serialized service
 * @param request owner authenticated request
 * @returns JSON response
 */
export async function handleMoveRequest(moveTop, request) {
    const headers = { 'cache-control': 'no-store' };
    try {
        if (request.method !== 'POST')
            return Response.json({ ok: false, message: '不支持的请求方式' }, { status: 405, headers });
        let body;
        try {
            body = await request.json();
        }
        catch {
            return Response.json({ ok: false, message: '请求不是合法 JSON' }, { status: 400, headers });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || !('workspaceId' in body) || typeof body.workspaceId !== 'string' || !body.workspaceId.trim() || !('action' in body) || body.action !== MOVE_ACTION) {
            return Response.json({ ok: false, message: `需要工作区 ID 与 action: '${MOVE_ACTION}'` }, { status: 400, headers });
        }
        const result = await moveTop.moveToTop(body.workspaceId);
        return Response.json(result, { status: result.ok ? 200 : 409, headers });
    }
    catch {
        return Response.json({ ok: false, message: '移动未完成，请刷新后重试' }, { status: 500, headers });
    }
}
/** Register the optional connection route with an effect disposer.
 * @param ctx plugin context
 * @param moveTop serialized service
 * @returns nothing
 */
export function installMoveRoute(ctx, moveTop) {
    ctx.inject(['connection'], scope => {
        scope.effect(() => scope.connection.fetch.register({ path: MOVE_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: request => handleMoveRequest(moveTop, request) }));
    });
}
