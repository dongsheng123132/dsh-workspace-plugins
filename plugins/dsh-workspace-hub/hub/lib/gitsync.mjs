/**
 * GitHub（或任何 git remote）作为「账本事件日志」的共享盘。
 *
 * 设计：**复用 `hub/lib/sync.mjs` 的目录传输层**——把 git 仓库 checkout 到本地后，
 * `repo/sync/` 就是一个普通同步目录（devices/<id>/events.jsonl + ledger.snapshot.json）。
 * git 只负责把各设备的追加日志搬来搬去，不参与合并；合并仍由 HLC/LWW 逻辑完成。
 *
 * 为什么不用 git 直接同步 app 状态文件：那些是各家私有格式、可能含凭据；
 * 这里只同步 KB 级的 `ledger` 事件（路径、标题、置顶、删除墓碑）。
 *
 * 冲突策略：
 *   - 每台设备只写 `sync/devices/<自己id>/events.jsonl`，天然不冲突；
 *   - 其它文件（snapshot）用 `git pull --rebase`；rebase 失败就 abort 并报错，绝不静默丢本地事件；
 *   - push 被拒 → pull --rebase 后重试一次。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadDevice } from './device.mjs'
import { sync as runSync } from './sync.mjs'
import { loadLedger, saveLedger } from './ledger.mjs'
import { pathKey } from './paths.mjs'
import { ensureDir, atomicWriteJson } from './safety.mjs'

/** 本地 git 工作副本默认位置：`<WSHUB_HOME>/git-sync`。 */
export function defaultRepoDir(home) {
  return path.join(home === undefined ? path.join(os.homedir(), '.workspace-hub') : home, 'git-sync')
}

function git(cwd, args, { timeout = 180000 } = {}) {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=workspace-hub', '-c', 'user.email=workspace-hub@localhost', ...args],
    { ...(cwd ? { cwd } : {}), encoding: 'utf8', timeout, windowsHide: true }
  )
  return {
    ok: r.status === 0,
    code: r.status ?? -1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    error: r.error ? String(r.error.message ?? r.error) : undefined,
  }
}

function pruneLedger(ledger) {
  const homeKey = pathKey(os.homedir())
  ledger.workspaces = (ledger.workspaces || []).filter((w) => w.path && pathKey(w.path) !== homeKey)
  return ledger
}

/** 确保本地有可用的 git 工作副本（clone 或复用），并指向给定 remote。 */
export function ensureRepo({ repoUrl, repoDir }) {
  ensureDir(path.dirname(repoDir))
  const dotGit = path.join(repoDir, '.git')
  if (fs.existsSync(dotGit)) {
    const current = git(repoDir, ['remote', 'get-url', 'origin'])
    if (!current.ok) git(repoDir, ['remote', 'add', 'origin', repoUrl])
    else if (current.stdout.trim() !== repoUrl) git(repoDir, ['remote', 'set-url', 'origin', repoUrl])
    return { ok: true, created: false, repoDir }
  }
  const clone = git(undefined, ['clone', repoUrl, repoDir])
  if (clone.ok) return { ok: true, created: true, cloned: true, repoDir }
  // 空仓或暂时不可达：本地初始化，稍后 push 建立 main
  ensureDir(repoDir)
  const init = git(repoDir, ['init', '-b', 'main'])
  if (!init.ok) return { ok: false, error: init.stderr || init.error || 'git init failed', repoDir }
  git(repoDir, ['remote', 'add', 'origin', repoUrl])
  return { ok: true, created: true, cloned: false, repoDir }
}

/** fetch + rebase；无 origin/main 时视为首次推送。 */
export function pullRepo(repoDir) {
  const branch = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const current = branch.ok ? branch.stdout.trim() : 'main'
  const fetch = git(repoDir, ['fetch', 'origin', current])
  if (!fetch.ok) return { ok: false, error: fetch.stderr || fetch.error || 'git fetch failed; local state preserved' }
  // --autostash：工作区里可能有刚生成的事件/snapshot（未提交），先暂存再 rebase，避免
  // 插件/launchd 自动同步时因 'unstaged changes' 直接失败。
  const pull = git(repoDir, ['pull', '--rebase', '--autostash', 'origin', current])
  if (!pull.ok) {
    git(repoDir, ['rebase', '--abort'])
    return { ok: false, error: pull.stderr || pull.error || 'git pull failed; local state preserved' }
  }
  return { ok: true, skipped: false }
}

/** add + commit + push（无变更就跳过）。push 被拒时 pull --rebase 后重试一次。 */
export function commitAndPush(repoDir, message) {
  git(repoDir, ['add', '-A'])
  const status = git(repoDir, ['status', '--porcelain'])
  const dirty = status.ok && status.stdout.trim().length > 0
  if (dirty) {
    const commit = git(repoDir, ['commit', '-m', message, '--no-verify'])
    if (!commit.ok) return { ok: false, error: commit.stderr || commit.error || 'commit failed' }
  }
  const branch = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const current = branch.ok ? branch.stdout.trim() : 'main'
  let push = git(repoDir, ['push', '-u', 'origin', current])
  if (!push.ok) {
    const pull = pullRepo(repoDir)
    if (!pull.ok) return { ok: false, error: pull.error || 'push rejected and rebase failed' }
    push = git(repoDir, ['push', '-u', 'origin', current])
  }
  return { ok: push.ok, committed: dirty, pushed: push.ok, error: push.ok ? undefined : push.stderr || push.error }
}

/**
 * Read one exclude list; a missing or broken file counts as empty (same policy as
 * the DSH plugin's `ledger.ts`).
 * @param {string} file absolute path
 * @returns {string[]} paths
 */
export function readExcludeFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(raw) ? raw.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * Make `exclude.json` a cross-device shared list: the repo copy
 * (`<repo>/sync/exclude.json`) and the local copy are unioned into both.
 *
 * **Not wired into {@link gitSync} yet.** Set union has no delete semantics: a path
 * unlocked/removed on one device comes back from the other device's older copy.
 * Correct sharing needs a per-path last-write-wins tombstone (`{excluded, at}`),
 * which is deferred; the function and its tests stay here as the building block.
 * @param {string} repoDir git working copy
 * @param {string} home hub home (holds `exclude.json`)
 * @param {boolean} [dryRun] compute without writing
 * @returns {{repo:number, local:number, merged:number, repoChanged:boolean, localChanged:boolean}}
 */
export function mergeSharedExclude(repoDir, home, dryRun = false) {
  const repoFile = path.join(repoDir, 'sync', 'exclude.json')
  const localFile = path.join(home, 'exclude.json')
  const repo = readExcludeFile(repoFile)
  const local = readExcludeFile(localFile)
  const merged = [...new Set([...repo, ...local])].sort()
  const repoChanged = JSON.stringify(merged) !== JSON.stringify([...new Set(repo)].sort())
  const localChanged = JSON.stringify(merged) !== JSON.stringify([...new Set(local)].sort())
  if (!dryRun) {
    if (localChanged) {
      ensureDir(home)
      atomicWriteJson(localFile, merged)
    }
    if (repoChanged) {
      ensureDir(path.dirname(repoFile))
      atomicWriteJson(repoFile, merged)
    }
  }
  return { repo: repo.length, local: local.length, merged: merged.length, repoChanged, localChanged }
}

/**
 * 一次完整 git 同步：确保仓库 → pull → 合并事件 → 保存账本 →（可选）commit+push。
 *
 * 注意：`exclude.json` **故意不参与**跨设备同步（v0.3.4 第一版试过并集，发现一个真问题：
 * 并集没有删除语义——本机解锁/删除的条目会被对端的旧名单并回来，形成"删除复活"。
 * 要正确共享需要按路径 LWW 墓碑（记 updatedAt），留给后续版本；当前每台机器各自维护
 * 屏蔽名单，见 `mergeSharedExclude` 的说明与 `docs/CROSS-DEVICE.md`。
 * @param {{repoUrl:string, home:string, repoDir?:string, push?:boolean, dryRun?:boolean, message?:string}} opts
 */
export function gitSync(opts) {
  const { repoUrl, home, push = true, dryRun = false } = opts
  if (!repoUrl) return { ok: false, error: '缺少 repoUrl' }
  const repoDir = opts.repoDir || defaultRepoDir(home)
  const ensured = ensureRepo({ repoUrl, repoDir })
  if (!ensured.ok) return { ok: false, ...ensured }
  const pulled = dryRun ? { ok: true, skipped: true } : pullRepo(repoDir)

  const device = loadDevice(home).device
  const before = loadLedger(home)
  const res = runSync(path.join(repoDir, 'sync'), {
    home,
    device,
    ...(before.ledger.workspaces.length ? { baseLedger: before.ledger } : {}),
    dryRun,
    snapshot: true,
  })
  const ledger = pruneLedger(res.ledger)
  if (!dryRun) saveLedger(home, ledger)

  let commit = { ok: true, skipped: true }
  if (!dryRun && push) {
    commit = commitAndPush(repoDir, opts.message || `sync ${device.name} ${new Date().toISOString()}`)
  }
  return {
    ok: pulled.ok && commit.ok,
    repoUrl,
    repoDir,
    device: { id: device.id, name: device.name },
    pull: { ok: pulled.ok, ...(pulled.skipped !== undefined ? { skipped: pulled.skipped } : {}), ...(pulled.error ? { error: pulled.error } : {}) },
    sync: { workspaces: ledger.workspaces.length, stats: res.stats, changes: res.changes },
    commit,
    dryRun,
  }
}
