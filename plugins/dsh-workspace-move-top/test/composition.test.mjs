import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { handleMoveRequest } from '../lib/move-route.js'

/** Faithful stub of `@deepseek-ai/dsh-workspace` WorkspaceRegistry order contract:
 * `insertBefore(id, beforeId)` moves `id` before the anchor (or appends without
 * one), throws on unknown ids, no-ops on `beforeId === id`, and only counts a
 * durable move when the order actually changes. */
class Registry extends Service {
  constructor(ctx, initial) {
    super(ctx, 'workspaceRegistry')
    this.items = (initial ?? ['a', 'b', 'c']).map(id => ({ id, path: `/projects/${id}`, title: 'same' }))
    this.moves = 0
  }
  list() { return [...this.items] }
  async insertBefore(id, beforeId) {
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(this.items.some(item => item.id === id), `move target '${id}' must exist`)
    if (beforeId !== undefined) assert.ok(this.items.some(item => item.id === beforeId), `anchor '${beforeId}' must exist`)
    if (beforeId === id) return this.items.map(item => item.id)
    const entry = this.items.find(item => item.id === id)
    const without = this.items.filter(item => item.id !== id)
    const at = beforeId === undefined ? without.length : without.findIndex(item => item.id === beforeId)
    const next = [...without.slice(0, at), entry, ...without.slice(at)]
    const before = this.items.map(item => item.id).join(',')
    this.items = next
    if (next.map(item => item.id).join(',') !== before) this.moves++
    return this.items.map(item => item.id)
  }
}

async function boot(t, { initial, pinsContent } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'move-top-'))
  const pinsPath = path.join(dir, 'pins.json')
  if (pinsContent !== undefined) await writeFile(pinsPath, pinsContent)
  const ctx = new Context()
  t.after(async () => { await ctx.registry.delete(plugin); await rm(dir, { recursive: true, force: true }) })
  await ctx.plugin({ name: 'registry-fixture', apply(scope) { new Registry(scope, initial) } })
  await ctx.plugin(plugin)
  return { ctx, pinsPath, registry: ctx.workspaceRegistry, service: ctx.wshubWorkspaceMoveTop }
}

const post = body => new Request('http://localhost/move', { method: 'POST', body: JSON.stringify(body) })

test('real Cordis composition activates headless and never reorders on boot', async t => {
  const { ctx, registry, service } = await boot(t, { initial: ['c', 'a', 'b'] })
  assert.deepEqual(registry.list().map(e => e.id), ['c', 'a', 'b'], 'prior manual drag order is preserved')
  assert.equal(registry.moves, 0, 'boot performs no insertBefore')
  assert.deepEqual(plugin.inject, ['workspaceRegistry'])
  assert.ok(service)
  await ctx.registry.delete(plugin)
  assert.equal(ctx.wshubWorkspaceMoveTop, undefined)
})

test('moveToTop moves C to first, then B to first leaving C second', async t => {
  const { registry, service } = await boot(t)
  const c = await service.moveToTop('c')
  assert.equal(c.ok, true)
  assert.equal(c.moved, true)
  assert.deepEqual(c.order, ['c', 'a', 'b'])
  assert.deepEqual(registry.list().map(e => e.id), ['c', 'a', 'b'])
  assert.equal(registry.moves, 1)

  const b = await service.moveToTop('b')
  assert.equal(b.ok, true)
  assert.equal(b.moved, true)
  assert.deepEqual(b.order, ['b', 'c', 'a'])
  assert.deepEqual(registry.list().map(e => e.id), ['b', 'c', 'a'])
  assert.equal(registry.moves, 2)
})

test('already-first is a no-op and unknown ids never change the order', async t => {
  const { registry, service } = await boot(t, { initial: ['c', 'a', 'b'] })
  const first = await service.moveToTop('c')
  assert.equal(first.ok, true)
  assert.equal(first.moved, false)
  assert.deepEqual(first.order, ['c', 'a', 'b'])
  assert.equal(registry.moves, 0, 'already-first performs no insertBefore')

  const missing = await service.moveToTop('zzz')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'none')
  assert.deepEqual(registry.list().map(e => e.id), ['c', 'a', 'b'])
  assert.equal(registry.moves, 0, 'unknown id performs no insertBefore')
})

test('concurrent moveToTop calls share one serialized queue', async t => {
  const { registry, service } = await boot(t)
  const first = service.moveToTop('c')
  const second = service.moveToTop('a')
  await Promise.all([first, second])
  // Serialized: c → [c,a,b], then a → [a,c,b]. Unserialized reads would interleave.
  assert.deepEqual(registry.list().map(e => e.id), ['a', 'c', 'b'])
  assert.equal(registry.moves, 2)
})

test('route accepts only move-to-top bodies and reports errors', async t => {
  const { registry, service } = await boot(t)
  const moved = await handleMoveRequest(service, post({ workspaceId: 'c', action: 'move-to-top' }))
  assert.equal(moved.status, 200)
  assert.equal(moved.headers.get('cache-control'), 'no-store')
  const movedBody = await moved.json()
  assert.equal(movedBody.ok, true)
  assert.equal(movedBody.moved, true)
  assert.deepEqual(movedBody.workspaces.map(w => w.id), ['c', 'a', 'b'])
  assert.deepEqual(registry.list().map(e => e.id), ['c', 'a', 'b'])

  for (const body of [[], null, {}, { workspaceId: '', action: 'move-to-top' }, { workspaceId: 'a' }, { workspaceId: 'a', action: 'pin' }, { action: 'move-to-top' }, { workspaceId: 1, action: 'move-to-top' }]) {
    assert.equal((await handleMoveRequest(service, post(body))).status, 400, `rejects ${JSON.stringify(body)}`)
  }
  assert.equal((await handleMoveRequest(service, post({ workspaceId: 'zzz', action: 'move-to-top' }))).status, 409, 'unknown id is 409')
  assert.equal((await handleMoveRequest(service, new Request('http://localhost/move'))).status, 405, 'GET is no longer a method')
  assert.equal((await handleMoveRequest(service, new Request('http://localhost/move', { method: 'DELETE' }))).status, 405)
  assert.equal((await handleMoveRequest(service, new Request('http://localhost/move', { method: 'POST', body: '{' }))).status, 400)
})

test('legacy corrupted pins.json is never read or written', async t => {
  const { pinsPath, registry, service } = await boot(t, { pinsContent: '{bad' })
  // Boot succeeded above; the legacy file is untouched.
  assert.equal(await readFile(pinsPath, 'utf8'), '{bad')

  await service.moveToTop('c')
  assert.deepEqual(registry.list().map(e => e.id), ['c', 'a', 'b'])
  assert.equal(await readFile(pinsPath, 'utf8'), '{bad', 'moveToTop never rewrites the legacy pins file')

  await service.moveToTop('zzz')
  assert.equal(await readFile(pinsPath, 'utf8'), '{bad', 'failed move never rewrites the legacy pins file')
})
