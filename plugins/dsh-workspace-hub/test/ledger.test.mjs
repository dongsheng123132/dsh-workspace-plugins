import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { defaultLedgerPath, expandHomePath, readLedger } from '../lib/ledger.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wshub-ledger-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('readLedger reports a missing ledger instead of throwing', async (t) => {
  const dir = await tempDir(t)
  const snapshot = await readLedger(path.join(dir, 'ledger.json'))
  assert.equal(snapshot.state, 'missing')
  assert.match(snapshot.message ?? '', /账本不存在/)
  assert.deepEqual(snapshot.entries, [])
})

test('readLedger reports invalid JSON', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'ledger.json')
  await writeFile(file, '{ not json')
  const snapshot = await readLedger(file)
  assert.equal(snapshot.state, 'invalid-json')
  assert.match(snapshot.message ?? '', /合法 JSON/)
})

test('readLedger rejects a wrong shape', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'ledger.json')
  await writeFile(file, JSON.stringify({ version: 1, workspaces: { nope: true } }))
  const snapshot = await readLedger(file)
  assert.equal(snapshot.state, 'invalid-shape')
})

test('readLedger returns entries in ledger order and keeps raw records', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'ledger.json')
  const ledger = {
    version: 1,
    updatedAt: '2026-10-29T01:28:00.000Z',
    workspaces: [
      { path: '/a', displayName: 'A', kind: 'project', pinned: true },
      { path: '/b' },
      'not-a-record',
    ],
  }
  await writeFile(file, JSON.stringify(ledger))
  const snapshot = await readLedger(file)
  assert.equal(snapshot.state, 'ok')
  assert.equal(snapshot.updatedAt, '2026-10-29T01:28:00.000Z')
  assert.equal(snapshot.entries.length, 3)
  assert.equal(snapshot.entries[0]?.path, '/a')
  assert.deepEqual(snapshot.entries[2], {})
})

test('defaultLedgerPath follows WSHUB_HOME and falls back to ~/.workspace-hub', () => {
  const previous = { WSHUB_HOME: process.env.WSHUB_HOME, WDHUB_HOME: process.env.WDHUB_HOME }
  try {
    delete process.env.WDHUB_HOME
    process.env.WSHUB_HOME = '/tmp/custom-hub'
    assert.equal(defaultLedgerPath(), path.join('/tmp/custom-hub', 'ledger.json'))

    delete process.env.WSHUB_HOME
    process.env.WDHUB_HOME = '/tmp/legacy-hub'
    assert.equal(defaultLedgerPath(), path.join('/tmp/legacy-hub', 'ledger.json'))

    delete process.env.WDHUB_HOME
    assert.ok(defaultLedgerPath().endsWith(path.join('.workspace-hub', 'ledger.json')))
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('expandHomePath only rewrites a leading tilde segment', () => {
  assert.ok(!expandHomePath('~foo/x').startsWith(path.sep))
  assert.equal(expandHomePath('/abs/~x'), '/abs/~x')
  assert.equal(expandHomePath('relative/x'), 'relative/x')
})
