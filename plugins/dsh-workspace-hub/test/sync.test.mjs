import assert from 'node:assert/strict'
import test from 'node:test'
import { executeSyncPlan } from '../lib/sync.js'

function candidate(name) {
  return {
    path: `/ledger/${name}`,
    canonicalPath: `/real/${name}`,
    title: name,
    kind: 'project',
    pinned: false,
    presentIn: [],
  }
}

function plan(candidates) {
  return {
    ledgerPath: '/tmp/ledger.json',
    ledgerState: 'ok',
    total: candidates.length,
    candidates,
    present: [],
    skipped: [],
    alreadyPresent: 0,
  }
}

function fakeRegistry({ failFor } = {}) {
  const created = []
  const registered = []
  return {
    created,
    list: () => registered,
    async create(path, title) {
      if (failFor !== undefined && path.includes(failFor)) throw new Error('EACCES: permission denied')
      created.push({ path, title })
      const workspace = { id: `id-${created.length}`, path, title: title ?? path }
      registered.push(workspace)
      return workspace
    },
  }
}

test('creates in reverse ledger order so the sidebar top matches the ledger', async () => {
  const registry = fakeRegistry()
  const result = await executeSyncPlan(
    registry,
    plan([candidate('a'), candidate('b'), candidate('c')]),
    { dryRun: false },
  )
  assert.deepEqual(
    registry.created.map((entry) => entry.title),
    ['c', 'b', 'a'],
  )
  // Reported order is sidebar order (top first), not creation order.
  assert.deepEqual(
    result.added.map((entry) => entry.title),
    ['a', 'b', 'c'],
  )
  assert.equal(result.registryTotal, 3)
  assert.equal(result.aborted, false)
  assert.equal(result.failed.length, 0)
})

test('a dry run plans without touching the registry', async () => {
  const registry = fakeRegistry()
  const result = await executeSyncPlan(registry, plan([candidate('a')]), { dryRun: true })
  assert.equal(registry.created.length, 0)
  assert.equal(result.dryRun, true)
  assert.deepEqual(
    result.added.map((entry) => entry.title),
    ['a'],
  )
  assert.equal(result.registryTotal, 0)
})

test('one failure does not abort the remaining candidates', async () => {
  const registry = fakeRegistry({ failFor: '/real/b' })
  const result = await executeSyncPlan(
    registry,
    plan([candidate('a'), candidate('b'), candidate('c')]),
    { dryRun: false },
  )
  assert.deepEqual(
    result.added.map((entry) => entry.title),
    ['a', 'c'],
  )
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0]?.title, 'b')
  assert.match(result.failed[0]?.error ?? '', /EACCES/)
})

test('an aborted signal stops before the first create', async () => {
  const registry = fakeRegistry()
  const controller = new AbortController()
  controller.abort()
  const result = await executeSyncPlan(registry, plan([candidate('a')]), {
    dryRun: false,
    signal: controller.signal,
  })
  assert.equal(registry.created.length, 0)
  assert.equal(result.aborted, true)
})

test('result carries ledger failure state through for the model', async () => {
  const registry = fakeRegistry()
  const result = await executeSyncPlan(
    registry,
    {
      ledgerPath: '/tmp/ledger.json',
      ledgerState: 'missing',
      ledgerMessage: '账本不存在',
      total: 0,
      candidates: [],
      present: [],
      skipped: [],
      alreadyPresent: 0,
    },
    { dryRun: false },
  )
  assert.equal(result.ledgerState, 'missing')
  assert.equal(result.ledgerMessage, '账本不存在')
  assert.equal(result.added.length, 0)
})
