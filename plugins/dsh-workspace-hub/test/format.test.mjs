import assert from 'node:assert/strict'
import test from 'node:test'
import { buildListView, formatListText, formatSyncText } from '../lib/format.js'

const candidate = {
  path: '/Users/x/claude/side-ai',
  canonicalPath: '/Users/x/claude/side-ai',
  title: 'side-ai',
  kind: 'project',
  pinned: false,
  presentIn: ['codex', 'trae'],
}

const present = {
  path: '/Users/x/claude/owned',
  canonicalPath: '/Users/x/claude/owned',
  title: 'owned',
}

const skipped = {
  path: '/Users/x/WorkBuddy/2026-10-29',
  title: 'WorkBuddy task',
  reason: 'unsupported-kind',
  message: '不是用户项目（kind 不是 project），默认不播种',
}

function plan() {
  return {
    ledgerPath: '/Users/x/.workspace-hub/ledger.json',
    ledgerState: 'ok',
    ledgerUpdatedAt: '2026-10-29T01:28:00.000Z',
    total: 3,
    candidates: [candidate],
    present: [present],
    skipped: [skipped],
    alreadyPresent: 1,
  }
}

test('buildListView joins the plan with registry and config facts', () => {
  const view = buildListView(plan(), {
    registryTotal: 61,
    maxAdd: 30,
    dryRun: false,
    lastSyncAt: '2026-10-29T02:00:00.000Z',
  })
  assert.equal(view.inDsh, 1)
  assert.equal(view.candidates, 1)
  assert.equal(view.skipped, 1)
  assert.equal(view.registryTotal, 61)
  assert.deepEqual(
    view.entries.map((entry) => entry.state),
    ['candidate', 'in-dsh', 'skipped'],
  )
})

test('formatListText is Chinese and states what can be synced', () => {
  const view = buildListView(plan(), { registryTotal: 61, maxAdd: 30, dryRun: false })
  const text = formatListText(view)
  assert.match(text, /DSH 工作区账本总览/)
  assert.match(text, /可同步：1/)
  assert.match(text, /\[可同步\] side-ai/)
  assert.match(text, /\[已在 DSH\] owned/)
  assert.match(text, /跳过：不是用户项目/)
  assert.match(text, /workspace_hub_sync/)
})

test('formatListText surfaces a missing ledger with the fix', () => {
  const view = buildListView(
    {
      ledgerPath: '/Users/x/.workspace-hub/ledger.json',
      ledgerState: 'missing',
      ledgerMessage: '账本不存在',
      total: 0,
      candidates: [],
      present: [],
      skipped: [],
      alreadyPresent: 0,
    },
    { registryTotal: 61, maxAdd: 30, dryRun: false },
  )
  const text = formatListText(view)
  assert.match(text, /状态：missing/)
  assert.match(text, /原因：账本不存在/)
  assert.match(text, /DSH 当前工作区：61 个/)
})

function syncResult(overrides = {}) {
  return {
    dryRun: false,
    startedAt: '2026-10-29T02:00:00.000Z',
    durationMs: 12,
    ledgerPath: '/Users/x/.workspace-hub/ledger.json',
    ledgerState: 'ok',
    total: 3,
    alreadyPresent: 1,
    added: [{ path: candidate.path, title: candidate.title, workspaceId: 'uuid-1' }],
    skipped: [skipped],
    failed: [],
    aborted: false,
    registryTotal: 62,
    ...overrides,
  }
}

test('formatSyncText numbers new workspaces in sidebar order', () => {
  const text = formatSyncText(syncResult())
  assert.match(text, /DSH 工作区同步结果/)
  assert.match(text, /新增：1/)
  assert.match(text, /1\. side-ai/)
  assert.match(text, /跳过：/)
  assert.match(text, /DSH 当前工作区：62 个/)
})

test('formatSyncText explains a pass that added nothing', () => {
  const text = formatSyncText(syncResult({ added: [], skipped: [], alreadyPresent: 3 }))
  assert.match(text, /本次没有需要新增的工作区/)
  assert.doesNotMatch(text, /将新增/)
})

test('formatSyncText labels a dry run and lists failures', () => {
  const text = formatSyncText(
    syncResult({
      dryRun: true,
      failed: [{ path: '/Users/x/locked', title: 'locked', error: 'EACCES' }],
    }),
  )
  assert.match(text, /演练（未写入）/)
  assert.match(text, /将新增（按侧栏从上到下）/)
  assert.match(text, /失败（可在修复目录\/权限后重试）：/)
  assert.match(text, /locked.*EACCES/)
})
