/**
 * 把 Workspace Hub 接入其它 AI 工具（Codex / Claude Code / WorkBuddy / DSH）。
 *
 * 每家提供两种能力：
 *   1. **MCP**：工具能直接调用 workspaces_list / workspace_plan / workspaces_open；
 *   2. **SessionStart hook**：工具启动时后台跑一次 `wshub auto`（拉取 → 扫描本机 → 推送），
 *      这样"哪个 AI 工具先打开，它就顺手把全机项目同步一遍"。
 * 另有一个通用兜底：launchd 定时任务（每 N 分钟 auto），覆盖没有 hook 的工具。
 *
 * 这里只做「登记」；所有写操作先备份到 `<WSHUB_HOME>/backups/integrations/<时间戳>/`。
 * 各家的配置格式在 2026-10-29 实测一致（hooks.SessionStart[].hooks[].command）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { atomicWriteJson, ensureDir, readJson, nowIso } from './safety.mjs'

const HOME = os.homedir()

function repoRoot() {
  // hub/lib/integrations.mjs → hub → repo；必须用 fileURLToPath，否则中文路径会被 %E5.. 编码
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..')
}
function hubCli() {
  return path.join(repoRoot(), 'hub', 'wdhub.mjs')
}
function mcpEntry() {
  return path.join(repoRoot(), 'hub', 'mcp.mjs')
}
function skillSrc() {
  return path.join(repoRoot(), 'skills', 'workspace-hub')
}

function backupFile(file, backupRoot, tag) {
  if (!fs.existsSync(file)) return null
  const stamp = nowIso().replace(/[:.]/g, '-')
  const dir = path.join(backupRoot, stamp)
  ensureDir(dir)
  const dest = path.join(dir, `${tag}-${path.basename(file)}`)
  fs.copyFileSync(file, dest)
  return dest
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** 后台执行、立即返回的 auto 命令；用于 SessionStart hook。 */
export function autoHookCommand(repoUrl, intervalLabel = '') {
  const cli = hubCli()
  const node = process.execPath
  const inner = `( cd ${shellQuote(repoRoot())} && ${shellQuote(node)} ${shellQuote(cli)} auto --repo ${shellQuote(repoUrl)} >/dev/null 2>&1 & ) ; true`
  return `bash -lc "${inner.replace(/"/g, '\\"')}"`
  }

/** 在标准 hooks 配置里追加/确保一条 SessionStart hook（幂等）。 */
export function ensureSessionStartHook(settingsFile, { tool, repoUrl, timeout = 15 }) {
  const r = readJson(settingsFile)
  if (!r.ok) {
    if (r.error === 'not-found') return { ok: false, reason: 'settings-not-found', file: settingsFile }
    return { ok: false, reason: 'settings-invalid', file: settingsFile }
  }
  const settings = r.value && typeof r.value === 'object' ? r.value : {}
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const starts = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : []
  const marker = '[workspace-hub] auto sync'
  const command = autoHookCommand(repoUrl)
  const existingIndex = starts.findIndex((s) => JSON.stringify(s).includes('workspace-hub'))
  if (existingIndex >= 0) {
    // 已存在则更新命令（修复旧路径/换仓库），幂等
    const before = JSON.stringify(starts[existingIndex])
    starts[existingIndex] = {
      matcher: '*',
      hooks: [{ type: 'command', command, timeout }],
      description: marker,
    }
    if (JSON.stringify(starts[existingIndex]) === before) {
      return { ok: true, changed: false, file: settingsFile }
    }
    settings.hooks.SessionStart = starts
    atomicWriteJson(settingsFile, settings)
    return { ok: true, changed: true, updated: true, file: settingsFile }
  }
  starts.push({
    matcher: '*',
    hooks: [{ type: 'command', command, timeout }],
    description: marker,
  })
  settings.hooks.SessionStart = starts
  atomicWriteJson(settingsFile, settings)
  return { ok: true, changed: true, file: settingsFile }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts })
  return { ok: r.status === 0, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error ? String(r.error.message) : undefined }
}

function hasMcpInListOutput(text, name) {
  // 各家格式不同：`name: cmd`（Claude）/ `name  cmd`（Codex）/ JSON；冒号也当分隔符
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  return new RegExp(`(^|\\s)${escaped}(?=[:：\\s]|$)`, 'm').test(text)
}

// ---------------------------------------------------------------------------
// 各工具：MCP 登记 + hook
// ---------------------------------------------------------------------------
export function ensureClaudeMcp() {
  const list = run('claude', ['mcp', 'list'])
  if (!list.ok) return { ok: false, skipped: true, reason: 'claude CLI 不可用' }
  if (hasMcpInListOutput(list.stdout, 'workspace-hub')) return { ok: true, changed: false }
  const add = run('claude', ['mcp', 'add', 'workspace-hub', '--', process.execPath, mcpEntry()])
  return { ok: add.ok, changed: add.ok, error: add.ok ? undefined : (add.stderr || add.error) }
}

export function ensureCodexMcp() {
  const list = run('codex', ['mcp', 'list'])
  if (!list.ok) return { ok: false, skipped: true, reason: 'codex CLI 不可用' }
  if (hasMcpInListOutput(list.stdout, 'workspace-hub')) return { ok: true, changed: false }
  const add = run('codex', ['mcp', 'add', 'workspace-hub', '--', process.execPath, mcpEntry()])
  return { ok: add.ok, changed: add.ok, error: add.ok ? undefined : (add.stderr || add.error) }
}

export function ensureWorkBuddyMcp() {
  const file = path.join(HOME, '.workbuddy', 'mcp.json')
  const r = readJson(file)
  if (!r.ok) {
    if (r.error === 'not-found') return { ok: false, skipped: true, reason: 'WorkBuddy 未安装/无 mcp.json' }
    return { ok: false, skipped: true, reason: 'mcp.json 解析失败' }
  }
  const cfg = r.value && typeof r.value === 'object' ? r.value : {}
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {}
  const desired = { command: process.execPath, args: [mcpEntry()] }
  const cur = cfg.mcpServers['workspace-hub']
  if (cur && JSON.stringify(cur) === JSON.stringify(desired)) return { ok: true, changed: false, file }
  cfg.mcpServers['workspace-hub'] = desired
  atomicWriteJson(file, cfg)
  return { ok: true, changed: true, file }
}

// ---------------------------------------------------------------------------
// launchd 定时兜底（macOS）
// ---------------------------------------------------------------------------
export function launchdPlistPath() {
  return path.join(HOME, 'Library', 'LaunchAgents', 'com.wshub.autosync.plist')
}

export function installLaunchd({ repoUrl, intervalSeconds = 600, nodePath = process.execPath }) {
  const plist = launchdPlistPath()
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wshub.autosync</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${hubCli()}</string>
    <string>auto</string>
    <string>--repo</string>
    <string>${repoUrl}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key><string>${path.join(HOME, '.workspace-hub', 'autosync.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(HOME, '.workspace-hub', 'autosync.log')}</string>
</dict>
</plist>
`
  ensureDir(path.dirname(plist))
  fs.writeFileSync(plist, body, 'utf8')
  const uid = process.getuid ? process.getuid() : 501
  run('launchctl', ['bootout', `gui/${uid}/com.wshub.autosync`])
  const boot = run('launchctl', ['bootstrap', `gui/${uid}`, plist])
  return { ok: boot.ok, changed: true, file: plist, error: boot.ok ? undefined : (boot.stderr || boot.error) }
}

export function isLaunchdLoaded() {
  const uid = process.getuid ? process.getuid() : 501
  const r = run('launchctl', ['print', `gui/${uid}/com.wshub.autosync`])
  return r.ok
}

// ---------------------------------------------------------------------------
// 安装 skill
// ---------------------------------------------------------------------------
export function installSkill() {
  const src = skillSrc()
  const dst = path.join(HOME, '.agents', 'skills', 'workspace-hub')
  if (!fs.existsSync(src)) return { ok: false, reason: 'skill source missing' }
  ensureDir(path.dirname(dst))
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })
  return { ok: true, changed: true, file: dst }
}

// ---------------------------------------------------------------------------
// 状态检查 / 一键安装
// ---------------------------------------------------------------------------
function checkHooks(settingsFile) {
  const r = readJson(settingsFile)
  if (!r.ok) return { installed: false, file: settingsFile }
  const text = JSON.stringify(r.value?.hooks?.SessionStart ?? [])
  return { installed: text.includes('workspace-hub'), file: settingsFile }
}

function checkWorkBuddyMcp() {
  const r = readJson(path.join(HOME, '.workbuddy', 'mcp.json'))
  return { installed: Boolean(r.ok && r.value?.mcpServers?.['workspace-hub']), file: path.join(HOME, '.workbuddy', 'mcp.json') }
}

function checkDshPlugin() {
  const profile = process.env.DSH_PROFILE || 'desktop'
  const pkg = path.join(HOME, '.dsh', 'profiles', profile, 'package.json')
  const r = readJson(pkg)
  const bundles = r.ok ? r.value?.dsh?.profile?.bundles ?? [] : []
  return { installed: bundles.includes('dsh-plugin-workspace-hub'), file: pkg }
}

/** 只读：列出每个工具的接入状态。 */
export function integrationStatus() {
  const claude = run('claude', ['mcp', 'list'])
  const codexList = run('codex', ['mcp', 'list'])
  const wb = checkWorkBuddyMcp()
  return {
    generatedAt: nowIso(),
    repoRoot: repoRoot(),
    hubCli: hubCli(),
    mcpEntry: mcpEntry(),
    tools: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        mcp: claude.ok && hasMcpInListOutput(claude.stdout, 'workspace-hub'),
        hook: checkHooks(path.join(HOME, '.claude', 'settings.json')).installed,
        config: path.join(HOME, '.claude', 'settings.json'),
      },
      {
        id: 'codex',
        name: 'Codex',
        mcp: codexList.ok && hasMcpInListOutput(codexList.stdout, 'workspace-hub'),
        hook: checkHooks(path.join(HOME, '.codex', 'hooks.json')).installed,
        config: path.join(HOME, '.codex', 'hooks.json'),
      },
      {
        id: 'workbuddy',
        name: 'WorkBuddy',
        mcp: wb.installed,
        hook: checkHooks(path.join(HOME, '.workbuddy', 'settings.json')).installed,
        config: path.join(HOME, '.workbuddy', 'settings.json'),
      },
      {
        id: 'dsh',
        name: 'DSH',
        mcp: true,
        hook: checkDshPlugin().installed,
        config: checkDshPlugin().file,
        note: 'DSH 用插件而不是 hook（插件激活即 scan+sync）',
      },
    ],
    launchd: { loaded: isLaunchdLoaded(), file: launchdPlistPath() },
    skill: fs.existsSync(path.join(HOME, '.agents', 'skills', 'workspace-hub', 'SKILL.md')),
  }
}

/**
 * 写入接入配置：MCP（Claude/Codex/WorkBuddy）+ SessionStart hook（三家）+ skill + launchd。
 * 所有被改写的文件先备份到 `<WSHUB_HOME>/backups/integrations/<时间戳>/`。
 */
export function applyIntegrations({ repoUrl, backupHome, daemon = true, intervalSeconds = 600 }) {
  if (!repoUrl) throw new Error('applyIntegrations 需要 repoUrl')
  const backupRoot = path.join(backupHome || path.join(HOME, '.workspace-hub'), 'backups', 'integrations')
  const stamp = nowIso().replace(/[:.]/g, '-')
  const tag = `integrations-${stamp}`
  const results = []
  const step = (id, fn) => {
    try {
      results.push({ id, ...fn() })
    } catch (error) {
      results.push({ id, ok: false, error: String(error?.message || error) })
    }
  }

  step('skill', () => installSkill())

  step('claude-mcp', () => ensureClaudeMcp())
  step('claude-hook', () => {
    const file = path.join(HOME, '.claude', 'settings.json')
    const bak = backupFile(file, backupRoot, tag)
    const r = ensureSessionStartHook(file, { tool: 'claude', repoUrl })
    return { ...r, backup: bak }
  })

  step('codex-mcp', () => ensureCodexMcp())
  step('codex-hook', () => {
    const file = path.join(HOME, '.codex', 'hooks.json')
    const bak = backupFile(file, backupRoot, tag)
    const r = ensureSessionStartHook(file, { tool: 'codex', repoUrl })
    return { ...r, backup: bak }
  })

  step('workbuddy-mcp', () => {
    const bak = backupFile(path.join(HOME, '.workbuddy', 'mcp.json'), backupRoot, tag)
    const r = ensureWorkBuddyMcp()
    return { ...r, backup: bak }
  })
  step('workbuddy-hook', () => {
    const file = path.join(HOME, '.workbuddy', 'settings.json')
    const bak = backupFile(file, backupRoot, tag)
    const r = ensureSessionStartHook(file, { tool: 'workbuddy', repoUrl })
    return { ...r, backup: bak }
  })

  if (daemon) step('launchd', () => installLaunchd({ repoUrl, intervalSeconds }))

  return { ok: results.every((x) => x.ok !== false), backupRoot, results }
}
