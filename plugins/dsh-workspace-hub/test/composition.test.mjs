import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

/**
 * Real-composition test: a real Cordis root, the real ToolRuntime and
 * SystemPrompt services, and the real plugin module (with its Schemastery
 * Config), against a stub `workspaceRegistry` that behaves like the DSH one
 * (canonical-path identity, prepend on create). This exercises the parts an
 * isolated unit test cannot: injection by service key, Config validation
 * through the Loader, tool registration/visibility, and the tool bodies.
 */
class StubWorkspaceRegistry extends Service {
  constructor(ctx) {
    super(ctx, 'workspaceRegistry')
    this.items = []
  }

  list() {
    return this.items
  }

  async insertBefore(id, beforeId) {
    const item = this.items.find((entry) => entry.id === id)
    this.items = this.items.filter((entry) => entry.id !== id)
    const at = beforeId === undefined ? this.items.length : this.items.findIndex((entry) => entry.id === beforeId)
    this.items.splice(at < 0 ? this.items.length : at, 0, item)
    return this.items.map((entry) => entry.id)
  }

  async create(canonicalPath, title) {
    const existing = this.items.find((item) => item.path === canonicalPath)
    if (existing !== undefined) return existing
    const workspace = { id: `ws-${this.items.length + 1}`, path: canonicalPath, title: title ?? canonicalPath }
    this.items.unshift(workspace)
    return workspace
  }
}

async function fixture(t, entries) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wshub-compose-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledgerPath = path.join(dir, 'ledger.json')
  const projects = []
  for (const name of ['alpha', 'beta']) {
    const project = path.join(dir, name)
    await mkdir(project)
    projects.push(project)
  }
  await writeFile(ledgerPath, JSON.stringify({ version: 1, workspaces: entries(projects) }))
  return { dir, ledgerPath, projects }
}

async function boot(t, config) {
  // Tests must not shell out to the real wshub CLI (it would rewrite the fixture ledger
  // from the developer machine's tools). Scan-on-start is covered separately.
  const isolated = { scanOnStart: false, ...config }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ name: 'stub-workspace-registry', apply: (scope) => { void new StubWorkspaceRegistry(scope) } })
  const fiber = ctx.plugin(plugin, isolated)
  await fiber
  t.after(() => ctx.registry.delete(plugin))
  return ctx
}

test('sync plugin no longer registers the independent favorites UI or tool', async (t) => {
  const { ledgerPath } = await fixture(t, (paths) => [{ path: paths[0], kind: 'project' }])
  const ctx = await boot(t, { ledgerPath, maxAdd: 30, dryRun: false, intervalSeconds: 0 })
  assert.equal(ctx.tools.get('workspace_hub_pin'), undefined)
  assert.equal(ctx.get('connection', { strict: false }), undefined)
})

const execution = () => ({
  signal: new AbortController().signal,
  callId: 'test-call',
  token: 'test-token',
  name: 'workspace_hub_unknown',
  arguments: {},
})

test('the plugin exposes its service and both tools through the real registries', async (t) => {
  const { ledgerPath, projects } = await fixture(t, (paths) => [
    { path: paths[0], displayName: 'Alpha 项目', kind: 'project', pinned: true, presentIn: ['codex'] },
    { path: paths[1], kind: 'project' },
    { path: path.join(path.dirname(paths[0]), 'missing'), kind: 'project' },
  ])
  const ctx = await boot(t, { ledgerPath, maxAdd: 30, dryRun: false, intervalSeconds: 0 })

  assert.equal(typeof ctx.wshubWorkspaceHub, 'object')
  assert.equal(ctx.wshubWorkspaceHub.config.ledgerPath, ledgerPath)

  const listTool = ctx.tools.get('workspace_hub_list')
  const syncTool = ctx.tools.get('workspace_hub_sync')
  assert.notEqual(listTool, undefined)
  assert.notEqual(syncTool, undefined)
  assert.match(listTool.description, /账本/)
  assert.match(syncTool.description, /幂等/)

  // Activation already populated the (stub) sidebar before any tool call.
  assert.deepEqual(
    ctx.wshubWorkspaceHub.lastSyncResult?.added.map((entry) => entry.title),
    ['Alpha 项目', 'beta'],
  )
  assert.deepEqual(
    new StubWorkspaceRegistryView(ctx).titles(),
    ['Alpha 项目', 'beta'],
  )
  assert.equal(projects.length, 2)
})

test('workspace_hub_list renders the ledger state for the model', async (t) => {
  const { ledgerPath } = await fixture(t, (paths) => [
    { path: paths[0], displayName: 'Alpha 项目', kind: 'project' },
    { path: paths[1], kind: 'project' },
    { path: path.join(path.dirname(paths[0]), 'missing'), kind: 'project' },
  ])
  const ctx = await boot(t, { ledgerPath, maxAdd: 30, dryRun: false, intervalSeconds: 0 })
  const definition = ctx.tools.get('workspace_hub_list')
  assert.ok(definition)

  const value = await definition.execute({}, execution())
  const content = definition.output.render({}, value)
  const text = content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
  assert.match(text, /DSH 工作区账本总览/)
  assert.equal(value.ledgerState, 'ok')
  assert.equal(value.total, 3)
  assert.equal(value.inDsh, 2)
  assert.match(text, /\[跳过：目录已不存在/)
})

test('workspace_hub_sync honours dryRun and then reports the ledger failure state', async (t) => {
  const { ledgerPath } = await fixture(t, (paths) => [{ path: paths[0], displayName: 'Alpha 项目', kind: 'project' }])
  const ctx = await boot(t, { ledgerPath, maxAdd: 30, dryRun: false, intervalSeconds: 0 })
  const definition = ctx.tools.get('workspace_hub_sync')
  assert.ok(definition)

  // Activation already added it; a second pass is an idempotent no-op.
  const again = await definition.execute({}, execution())
  assert.equal(again.added.length, 0)
  assert.equal(again.alreadyPresent, 1)
  const text = definition.output.render({}, again)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
  assert.match(text, /本次没有需要新增的工作区/)

  const dry = await definition.execute({ dryRun: true, maxAdd: 0 }, execution())
  assert.equal(dry.dryRun, true)
})

test('an activation pass with a missing ledger is reported, not fatal', async (t) => {
  const { dir } = await fixture(t, () => [])
  const ctx = await boot(t, {
    ledgerPath: path.join(dir, 'nope.json'),
    maxAdd: 30,
    dryRun: false,
    intervalSeconds: 0,
  })
  assert.equal(ctx.wshubWorkspaceHub.lastSyncResult?.ledgerState, 'missing')
  assert.notEqual(ctx.tools.get('workspace_hub_sync'), undefined)
})

test('invalid configuration fails plugin loading instead of being coerced', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ name: 'stub-workspace-registry', apply: (scope) => { void new StubWorkspaceRegistry(scope) } })
  await assert.rejects(async () => {
    await ctx.plugin(plugin, { ledgerPath: '/tmp/x.json', maxAdd: -1, dryRun: false, intervalSeconds: 0 })
  })
})

test('dryRun configuration prevents the activation pass from writing', async (t) => {
  const { ledgerPath } = await fixture(t, (paths) => [{ path: paths[0], displayName: 'Alpha 项目', kind: 'project' }])
  const ctx = await boot(t, { ledgerPath, maxAdd: 30, dryRun: true, intervalSeconds: 0 })
  assert.equal(ctx.wshubWorkspaceHub.lastSyncResult?.dryRun, true)
  assert.equal(new StubWorkspaceRegistryView(ctx).titles().length, 0)
})

/** Reads the stub registry the plugin was given. */
class StubWorkspaceRegistryView {
  constructor(ctx) {
    this.ctx = ctx
  }

  titles() {
    return this.ctx.workspaceRegistry.list().map((workspace) => workspace.title)
  }
}
