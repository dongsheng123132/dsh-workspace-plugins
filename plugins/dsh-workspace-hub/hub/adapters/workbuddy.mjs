/**
 * WorkBuddy 适配器（腾讯 WorkBuddy 5.9.x，Electron）
 *
 * 真相源：~/.workbuddy/workbuddy.db（明文 SQLite，实测 2026-10-29）
 *   workspaces(path TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL)  ← 左侧「工作目录」
 *   sessions(... cwd, title, last_activity_at ...)                      ← 左侧「任务/最近会话」
 *
 * 注意：
 *   - ~/Library/Application Support/WorkBuddy 里的 vscdb 是旧 CodeBuddy IDE 残留，不是真相源
 *   - app 运行中写库会被 WAL/内存覆盖，播种必须等 app 退出（见 docs/DESIGN.md §7）
 *   - sessions 与云端有同步字段（agent_dirty/agent_last_synced），不建议直插；workspaces 更干净
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRunningByCmdline } from '../lib/safety.mjs';
import { querySqlite } from '../lib/sqlite.mjs';
import { isUnderPath, openInAppPlan, runOpenPlan } from '../lib/platform.mjs';

const HOME = os.homedir();
/** macOS / Windows / Linux 都在家目录下的点目录（%USERPROFILE%\.workbuddy\workbuddy.db） */
const DB = path.join(HOME, '.workbuddy', 'workbuddy.db');
/** WorkBuddy 每新建一个任务会在 ~/WorkBuddy/<时间戳>/ 下自动建目录——这是 app 托管目录，不是用户项目 */
const APP_MANAGED_ROOT = path.join(HOME, 'WorkBuddy');

function kindOf(p) {
  return isUnderPath(p, APP_MANAGED_ROOT) ? 'app-managed' : 'project';
}

export default {
  id: 'workbuddy',
  name: 'WorkBuddy',
  kind: 'gui',
  capabilities: { read: true, seed: 'store-write', open: true, watch: true },
  statePaths: () => [DB],

  async read() {
    if (!fs.existsSync(DB)) return { entries: [], error: 'not-found', statePath: DB };
    const wsRes = await querySqlite(
      DB,
      'SELECT path, last_opened_at FROM workspaces ORDER BY last_opened_at DESC'
    );
    if (!wsRes.ok) return { entries: [], error: wsRes.error, statePath: DB };

    const entries = [];
    const seen = new Set();
    for (const row of wsRes.rows) {
      if (!row.path || seen.has(row.path)) continue;
      seen.add(row.path);
      entries.push({
        path: row.path,
        title: path.basename(row.path) || null,
        nativeId: row.path,
        lastActiveAt: row.last_opened_at || null,
        kind: kindOf(row.path),
        order: entries.length,
      });
    }

    // “任务”绑定的 cwd 也反映用户实际工作目录；补进来但排在 workspaces 之后
    const sesRes = await querySqlite(
      DB,
      "SELECT cwd, MAX(last_activity_at) AS last_activity_at, COUNT(*) AS n FROM sessions WHERE cwd IS NOT NULL AND cwd != '' GROUP BY cwd ORDER BY last_activity_at DESC"
    );
    let extraOrder = entries.length;
    if (sesRes.ok) {
      for (const row of sesRes.rows) {
        if (!row.cwd || seen.has(row.cwd)) continue;
        seen.add(row.cwd);
        entries.push({
          path: row.cwd,
          title: path.basename(row.cwd) || null,
          nativeId: null,
          lastActiveAt: row.last_activity_at || null,
          kind: kindOf(row.cwd),
          order: extraOrder++,
        });
      }
    }
    return {
      entries,
      statePath: DB,
      note: `${wsRes.rows.length} 个空间 / ${sesRes.ok ? sesRes.rows.length : '?'} 个任务目录`,
    };
  },

  async isRunning() {
    const patterns = process.platform === 'win32' ? ['WorkBuddy.exe'] : ['WorkBuddy.app/Contents'];
    return isRunningByCmdline(patterns);
  },

  /** 没有官方「打开目录」入口；macOS `open -a` / Windows `start` 实测会被接收但不写库，只能算尽力而为 */
  async open(target) {
    const plan = openInAppPlan('WorkBuddy', target);
    if (plan) runOpenPlan(plan);
    return { ok: true, how: plan?.how || target };
  },
};
