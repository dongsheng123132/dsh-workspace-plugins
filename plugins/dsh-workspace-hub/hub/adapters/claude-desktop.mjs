/**
 * Claude 桌面版适配器（Claude.app 里的 Claude Code 列表）
 *
 * 真相源（三平台同构，根目录不同）：
 *   macOS    ~/Library/Application Support/Claude/claude-code-sessions/
 *   Windows  %APPDATA%\Claude\claude-code-sessions\
 *   Linux    ~/.config/Claude/claude-code-sessions/
 *   <accountUuid>/<orgUuid>/local_<uuid>.json
 *   字段：{ sessionId, cliSessionId, cwd, originCwd, createdAt, lastActivityAt, isArchived, title, model, ... }
 *
 * 与 Claude Code CLI 的关系：**配置同源、列表不同源**。
 *   - CLI 的列表在 ~/.claude.json → projects（68 条）
 *   - 桌面版只显示自己在 claude-code-sessions 里创建的会话（13 条 / 6 个 cwd）
 *   - 桌面版会话的 transcript 会回写到 ~/.claude/projects（entrypoint=claude-desktop）
 * 所以两个适配器要分开读，不能互相替代。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRunningByCmdline } from '../lib/safety.mjs';
import { appDataCandidates, isUnderPath, openUrlPlan, resolveAppDataDir, runOpenPlan } from '../lib/platform.mjs';

/**
 * 解析 Claude 的应用数据目录与两个子目录。
 * 优先真实存在的候选（本机装了桌面版）；否则退回第一个候选，便于 doctor 显示“该去哪找”。
 */
export function claudeDesktopPaths({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const opts = { platform, env, homedir };
  const dataDir = resolveAppDataDir('Claude', opts) || appDataCandidates('Claude', opts)[0] || path.join(homedir, 'Claude');
  return {
    dataDir,
    sessionsDir: path.join(dataDir, 'claude-code-sessions'),
    scratchDir: path.join(dataDir, 'scratch-workspaces'),
  };
}

/** 桌面版给“临时会话”生成的 scratch 目录：属于 app 托管，不是用户项目 */
function kindOf(p, scratchDir) {
  return isUnderPath(p, scratchDir, { platform: process.platform }) ? 'app-managed' : 'project';
}

function listSessionFiles(sessionsDir) {
  const out = [];
  let accounts = [];
  try {
    accounts = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const acct of accounts) {
    const acctDir = path.join(sessionsDir, acct.name);
    let orgs = [];
    try {
      orgs = fs.readdirSync(acctDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const org of orgs) {
      const orgDir = path.join(acctDir, org.name);
      let files = [];
      try {
        files = fs.readdirSync(orgDir).filter((f) => f.startsWith('local_') && f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files) out.push(path.join(orgDir, f));
    }
  }
  return out;
}

export default {
  id: 'claude-desktop',
  name: 'Claude 桌面版',
  kind: 'gui',
  capabilities: { read: true, seed: 'deeplink', open: true, watch: true },
  statePaths: () => [claudeDesktopPaths().sessionsDir],

  async read() {
    const { sessionsDir, scratchDir } = claudeDesktopPaths();
    const files = listSessionFiles(sessionsDir);
    if (!files.length) return { entries: [], error: 'not-found', statePath: sessionsDir };
    const sessions = [];
    for (const file of files) {
      let d;
      try {
        d = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!d || d.isArchived) continue;
      const cwd = d.cwd || d.originCwd;
      if (!cwd) continue;
      sessions.push({
        path: cwd,
        title: d.title || null,
        nativeId: d.sessionId || null,
        lastActiveAt: d.lastActivityAt || d.lastFocusedAt || d.createdAt || null,
      });
    }
    // 同一目录可能有多个会话：按最近活跃排序后再按目录去重，保留最新那个的标题
    sessions.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
    const entries = [];
    const seen = new Set();
    for (const s of sessions) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      entries.push({ ...s, kind: kindOf(s.path, scratchDir), order: entries.length });
    }
    return { entries, statePath: sessionsDir, note: `${entries.length} 个会话目录` };
  },

  async isRunning() {
    // 三平台进程探测口径不同；Windows 上 pgrep 不存在时 isRunning* 返回 null（未知，保守方向安全）
    const patterns = process.platform === 'win32' ? ['Claude.exe'] : ['Claude.app/Contents'];
    return isRunningByCmdline(patterns);
  },

  /**
   * 官方深链接（Finder 右键“在 Claude Code 中打开”同款）。
   * 实测：URL 会被接收，但不会静默改列表——它是 UI 入口，会弹窗让用户确认。
   * Windows 上走 `start "" "claude://..."`（& 参数不会被 cmd 拆开）。
   */
  async open(target) {
    const url = `claude://code/new?folder=${encodeURIComponent(target)}&source=services`;
    const plan = openUrlPlan(url);
    if (plan) runOpenPlan(plan);
    return { ok: true, how: url };
  },
};
