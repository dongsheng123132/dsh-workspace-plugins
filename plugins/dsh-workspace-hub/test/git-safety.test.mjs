import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { pullRepo } from '../hub/lib/gitsync.mjs'

function run(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}
test('failed pull preserves divergent commits and never resets to remote', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wshub-git-safe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const remote = path.join(dir, 'remote.git'), a = path.join(dir, 'a'), b = path.join(dir, 'b')
  mkdirSync(remote); run(remote, 'init', '--bare', '--initial-branch=main')
  run(dir, 'clone', remote, a)
  writeFileSync(path.join(a, 'entry.txt'), 'base\n'); run(a, 'add', '.'); run(a, 'commit', '-m', 'base'); run(a, 'push', '-u', 'origin', 'main')
  run(dir, 'clone', remote, b)
  writeFileSync(path.join(a, 'entry.txt'), 'local\n'); run(a, 'commit', '-am', 'local')
  writeFileSync(path.join(b, 'entry.txt'), 'remote\n'); run(b, 'commit', '-am', 'remote'); run(b, 'push')
  const result = pullRepo(a)
  assert.equal(result.ok, false)
  assert.equal(readFileSync(path.join(a, 'entry.txt'), 'utf8'), 'local\n')
  const head = spawnSync('git', ['log', '-1', '--format=%s'], { cwd: a, encoding: 'utf8' })
  assert.equal(head.stdout.trim(), 'local')
})
