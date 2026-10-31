import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildSyncPlan, isOwnedByDsh } from '../lib/plan.js'

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'wshub-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectA = path.join(root, 'project-a')
  const projectB = path.join(root, '项目-b')
  const appManaged = path.join(root, 'app-managed')
  const owned = path.join(root, 'owned')
  const aFile = path.join(root, 'a-file')
  for (const dir of [projectA, projectB, appManaged, owned]) await mkdir(dir)
  await writeFile(aFile, 'x')
  const link = path.join(root, 'link-to-a')
  await symlink(projectA, link)
  return { root, projectA, projectB, appManaged, owned, aFile, link }
}

function snapshot(entries) {
  return { ledgerPath: '/tmp/ledger.json', state: 'ok', entries }
}

test('classifies ledger records into candidates, presents and skips', async (t) => {
  const ws = await workspace(t)
  const realOwned = await realpath(ws.owned)
  const plan = await buildSyncPlan(
    snapshot([
      { path: ws.projectA, displayName: '项目 A', kind: 'project', pinned: true, presentIn: ['codex'] },
      { path: ws.projectB, kind: 'project' },
      { path: ws.appManaged, kind: 'app-managed' },
      { path: ws.owned, kind: 'project' },
      { path: path.join(ws.root, 'gone'), kind: 'project' },
      { path: ws.aFile, kind: 'project' },
      { path: ws.link, kind: 'project' },
      { path: 'relative/dir', kind: 'project' },
      { displayName: 'no path' },
    ]),
    { existingPaths: [realOwned], maxAdd: 0 },
  )

  assert.equal(plan.total, 9)
  assert.equal(plan.candidates.length, 2)
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.title),
    ['项目 A', '项目-b'],
  )
  assert.equal(plan.candidates[0]?.pinned, true)
  assert.deepEqual(plan.candidates[0]?.presentIn, ['codex'])
  assert.equal(plan.alreadyPresent, 1)
  assert.deepEqual(
    plan.skipped.map((entry) => entry.reason),
    ['unsupported-kind', 'directory-missing', 'directory-missing', 'duplicate-path', 'invalid-path', 'invalid-entry'],
  )
})

test('a symlink to an already planned directory is a duplicate, not a second candidate', async (t) => {
  const ws = await workspace(t)
  const plan = await buildSyncPlan(
    snapshot([
      { path: ws.projectA, kind: 'project' },
      { path: ws.link, kind: 'project' },
    ]),
    { existingPaths: [], maxAdd: 0 },
  )
  assert.equal(plan.candidates.length, 1)
  assert.equal(plan.skipped[0]?.reason, 'duplicate-path')
  assert.equal(plan.candidates[0]?.canonicalPath, await realpath(ws.projectA))
})

test('missing kind counts as project, matching the wshub planner', async (t) => {
  const ws = await workspace(t)
  const plan = await buildSyncPlan(snapshot([{ path: ws.projectA }]), { existingPaths: [], maxAdd: 0 })
  assert.equal(plan.candidates.length, 1)
  assert.equal(plan.candidates[0]?.kind, 'project')
})

test('maxAdd caps candidates and reports the rest as max-add-limit', async (t) => {
  const ws = await workspace(t)
  const plan = await buildSyncPlan(
    snapshot([
      { path: ws.projectA, kind: 'project' },
      { path: ws.projectB, kind: 'project' },
    ]),
    { existingPaths: [], maxAdd: 1 },
  )
  assert.equal(plan.candidates.length, 1)
  assert.equal(plan.skipped[0]?.reason, 'max-add-limit')
})

test('an aborted signal stops planning between records', async (t) => {
  const ws = await workspace(t)
  const controller = new AbortController()
  controller.abort()
  const plan = await buildSyncPlan(
    snapshot([
      { path: ws.projectA, kind: 'project' },
      { path: ws.projectB, kind: 'project' },
    ]),
    { existingPaths: [], maxAdd: 0, signal: controller.signal },
  )
  assert.equal(plan.candidates.length, 0)
  assert.equal(plan.skipped.length, 0)
})

test('isOwnedByDsh compares canonical paths, not spellings', async (t) => {
  const ws = await workspace(t)
  const real = await realpath(ws.projectA)
  assert.equal(isOwnedByDsh(real, [ws.projectA]), false)
  assert.equal(isOwnedByDsh(real, [real]), true)
})
