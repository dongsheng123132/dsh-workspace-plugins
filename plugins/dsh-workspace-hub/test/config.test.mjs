import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { Config, resolveConfig } from '../lib/config.js'

test('Config applies the documented defaults', () => {
  const config = Config({})
  assert.equal(config.dryRun, false)
  assert.equal(config.maxAdd, 30)
  assert.equal(config.intervalSeconds, 0)
  assert.equal(config.scanOnStart, true)
  assert.equal(config.hubCliPath, '')
  assert.equal(config.gitRepo, '')
  assert.equal(config.gitSyncOnStart, false)
  assert.ok(config.ledgerPath.endsWith(path.join('.workspace-hub', 'ledger.json')))
})

test('Config accepts explicit values', () => {
  const config = Config({ ledgerPath: '~/custom/ledger.json', maxAdd: 0, dryRun: true, intervalSeconds: 300 })
  assert.equal(config.ledgerPath, '~/custom/ledger.json')
  assert.equal(config.maxAdd, 0)
  assert.equal(config.dryRun, true)
  assert.equal(config.intervalSeconds, 300)
})

test('Config rejects a negative maxAdd instead of coercing it', () => {
  assert.throws(() => Config({ maxAdd: -1 }))
})

test('Config rejects a fractional intervalSeconds', () => {
  assert.throws(() => Config({ intervalSeconds: 1.5 }))
})

test('Config rejects a non-boolean dryRun', () => {
  assert.throws(() => Config({ dryRun: 'yes' }))
})

test('resolveConfig makes ledgerPath absolute and expands a leading tilde', () => {
  const resolved = resolveConfig(Config({ ledgerPath: '~/custom/ledger.json' }))
  assert.equal(path.isAbsolute(resolved.ledgerPath), true)
  assert.ok(resolved.ledgerPath.endsWith(path.join('custom', 'ledger.json')))
  assert.equal(resolved.ledgerPath.includes('~'), false)
})
