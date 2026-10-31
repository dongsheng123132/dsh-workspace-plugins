/**
 * DSH 左侧工作区清理（dsh-prune）。
 *
 * 目的：把「AI 工具扫出来的目录」收敛成「真正会打开的项目」。
 * 只改 DSH 自己的 `storages/workspace.json`（先备份），**不删任何磁盘文件**；
 * 被清理掉的路径写进 `<WSHUB_HOME>/exclude.json`，插件以后不会再补回来。
 *
 * 三个档位：
 *   light       只删噪音：家/盘根目录、AI 工具数据目录、僵尸路径、容器型父目录（无 .git 且有子工作区）
 *   medium      再收紧：只保留「有会话 / 有 .git / 有项目标记文件（README/package.json/…）」的
 *   aggressive  只保留「有会话」的（最干净，其余靠 exclude 挡住，以后可手动加回）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { atomicWriteJson, ensureDir, nowIso } from './safety.mjs'

const HOME = os.homedir()
const ROOTS = new Set([
  HOME,
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'claude'),
  path.join(HOME, 'code'),
])
const DATA_RE = /(^|\/)(\.codex|\.hermes|\.dsh\/imports|\.ssh|DoubaoWork|AiToolData|AppData)(\/|$)/
const MARKERS = [
  '.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'README.md',
  'SKILL.md', 'AGENTS.md', 'pom.xml', 'build.gradle', 'requirements.txt', 'index.html',
]

export function defaultDshHome() {
  return path.join(HOME, '.dsh')
}

export function isDshRunning() {
  const r = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5000 })
  if (r.status !== 0) return false
  return /DeepSeek Harness\.app\/Contents\/MacOS\//.test(String(r.stdout ?? ''))
}

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function real(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

function hasGit(p) {
  return exists(path.join(p, '.git'))
}

function hasMarker(p) {
  for (const m of MARKERS) if (exists(path.join(p, m))) return true
  return false
}

function isNoise(p) {
  return ROOTS.has(p) || DATA_RE.test(p)
}

/** 读取 workspace.json，返回带会话数与原因分析的条目。 */
export function readWorkspaces(dshHome = defaultDshHome()) {
  const file = path.join(dshHome, 'storages', 'workspace.json')
  if (!exists(file)) throw new Error(`找不到 DSH 工作区文件：${file}`)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const table = parsed?.tables?.workspaces
  if (!table || typeof table !== 'object') throw new Error('workspace.json 结构不符：缺少 tables.workspaces')
  const ids = Array.isArray(parsed?.global?.workspaceIds) ? parsed.global.workspaceIds : []
  const entries = Object.entries(table).map(([id, w]) => ({
    id,
    path: String(w?.path ?? ''),
    title: String(w?.title ?? ''),
    sessions: Array.isArray(w?.sessionIds) ? w.sessionIds.length : 0,
    updatedAt: w?.updatedAt,
    missing: !exists(String(w?.path ?? '')),
    git: hasGit(String(w?.path ?? '')),
    marker: hasMarker(String(w?.path ?? '')),
    noise: isNoise(String(w?.path ?? '')),
  }))
  if (!ids.length) parsed.global = { ...(parsed.global ?? {}), workspaceIds: entries.map((e) => e.id) }
  return { file, parsed, entries, order: Array.isArray(parsed.global?.workspaceIds) ? parsed.global.workspaceIds : [] }
}

/** 分析应保留/删除哪些工作区。 */
export function analyzePrune(dshHome = defaultDshHome(), level = 'medium') {
  const { file, entries } = readWorkspaces(dshHome)
  const remove = new Map() // id -> reason
  const put = (e, reason) => {
    if (!remove.has(e.id)) remove.set(e.id, { ...e, reason })
  }

  // 1) 噪音：家/盘根目录、AI 工具数据目录（有会话的除外，避免丢组织关系）
  for (const e of entries) if (e.noise && e.sessions === 0) put(e, '根目录/数据目录')

  // 2) 僵尸路径
  for (const e of entries) if (e.missing) put(e, '目录已不存在')

  // 3) 容器型父目录：0 会话、无 .git、但下面还有别的工作区
  for (const e of entries) {
    if (e.sessions > 0 || e.git || !e.path) continue
    if (entries.some((o) => o.id !== e.id && o.path.startsWith(e.path + path.sep))) put(e, '容器型父目录')
  }

  // 4) 同一真实路径重复（保留会话多的）
  const byReal = new Map()
  for (const e of entries) {
    if (!e.path || e.missing) continue
    const r = real(e.path)
    byReal.set(r, [...(byReal.get(r) ?? []), e])
  }
  for (const group of byReal.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => b.sessions - a.sessions || a.path.length - b.path.length)
    for (const e of sorted.slice(1)) put(e, '同一目录重复')
  }

  if (level === 'medium' || level === 'aggressive') {
    for (const e of entries) {
      if (remove.has(e.id)) continue
      if (e.sessions > 0) continue
      const keep = level === 'medium' ? e.git || e.marker : false
      if (!keep) put(e, level === 'medium' ? '无会话且无项目标记' : '无会话（激进）')
    }
  }

  const removeList = [...remove.values()]
  const keepCount = entries.length - removeList.length
  const byReason = {}
  for (const r of removeList) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
  return { file, level, total: entries.length, keepCount, removeList, byReason }
}

/** 把清理结果写入 DSH 的 workspace.json（调用前必须先退出 DSH），并把路径写进 exclude.json。 */
export function applyPrune(analysis, { dshHome = defaultDshHome(), hubHome } = {}) {
  const { file, parsed } = readWorkspaces(dshHome)
  const removeIds = new Set(analysis.removeList.map((e) => e.id))
  const stamp = nowIso().replace(/[:.]/g, '-')
  const backup = `${file}.bak-dshprune-${stamp}`
  fs.copyFileSync(file, backup)

  for (const id of removeIds) delete parsed.tables.workspaces[id]
  parsed.global.workspaceIds = (parsed.global.workspaceIds ?? []).filter((id) => !removeIds.has(id))
  atomicWriteJson(file, parsed)

  // exclude.json：插件读到后不再把这些路径补回侧栏
  const home = hubHome || process.env.WSHUB_HOME || path.join(HOME, '.workspace-hub')
  ensureDir(home)
  const excludeFile = path.join(home, 'exclude.json')
  let prev = []
  try {
    const raw = JSON.parse(fs.readFileSync(excludeFile, 'utf8'))
    if (Array.isArray(raw)) prev = raw
  } catch {
    prev = []
  }
  const merged = [...new Set([...prev, ...analysis.removeList.map((e) => e.path).filter(Boolean)])].sort()
  atomicWriteJson(excludeFile, merged)
  return { backup, removed: removeIds.size, kept: analysis.keepCount, excludeFile }
}

/** 与本机路径比较用的键：绝对化 + 去尾部斜杠（与插件 `ledger.ts` 的口径一致）。 */
function compareKey(p) {
  try {
    return path.resolve(String(p)).replace(/[\\/]+$/, '')
  } catch {
    return String(p)
  }
}

function readExcludeList(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 把「账本里还有、但当前 DSH 侧栏没有」的路径一次性写进 `exclude.json`。
 *
 * 场景：手动在 DSH 侧栏里整理过项目（删掉不想要的），但 wshub 账本并不知道这些删除——
 * 下次插件播种会按账本把它们补回来。本命令把「账本 − 当前侧栏」的差集锁进 exclude，
 * 插件以后就不再补这些路径（包括从其它设备同步合并进来的同名条目）。
 *
 * 只读 `storages/workspace.json` + 写 `exclude.json`，**不写 DSH 注册表，不需要退出 DSH**。
 * 可逆：从 exclude.json 删掉对应行即可恢复播种。
 * @param {{dshHome?: string, hubHome?: string, dryRun?: boolean}} [opts]
 * @returns {{added: string[], total: number, excludeFile: string, sideCount: number, ledgerCount: number, dryRun: boolean}}
 */
export function lockMissingFromSidebar({ dshHome = defaultDshHome(), hubHome, dryRun = false } = {}) {
  const home = hubHome || process.env.WSHUB_HOME || path.join(HOME, '.workspace-hub')
  const { entries } = readWorkspaces(dshHome)
  const ledgerFile = path.join(home, 'ledger.json')
  if (!exists(ledgerFile)) throw new Error(`找不到账本：${ledgerFile}。先跑一次 \`wshub scan --save\`。`)
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
  const workspaces = Array.isArray(ledger?.workspaces) ? ledger.workspaces : []
  const sideKeys = new Set(entries.map((entry) => entry.path).filter(Boolean).map(compareKey))
  const excludeFile = path.join(home, 'exclude.json')
  const prev = readExcludeList(excludeFile)
  const seen = new Set(prev.map(compareKey))
  const added = []
  for (const workspace of workspaces) {
    const candidate = typeof workspace?.path === 'string' ? workspace.path : ''
    if (!candidate) continue
    const key = compareKey(candidate)
    if (sideKeys.has(key) || seen.has(key)) continue
    if (!exists(candidate)) continue
    try {
      if (!fs.statSync(candidate).isDirectory()) continue
    } catch {
      continue
    }
    seen.add(key)
    added.push(candidate)
  }
  if (!dryRun && added.length > 0) {
    ensureDir(home)
    atomicWriteJson(excludeFile, [...prev, ...added].sort())
  }
  return {
    added,
    total: prev.length + added.length,
    excludeFile,
    sideCount: entries.length,
    ledgerCount: workspaces.length,
    dryRun,
  }
}
