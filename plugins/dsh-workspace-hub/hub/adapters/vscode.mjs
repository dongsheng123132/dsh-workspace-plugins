/**
 * VS Code 系（Trae / Cursor / 其它 fork）适配器工厂
 *
 * 真相源（三平台同构，只是根目录不同）：
 *   macOS    ~/Library/Application Support/<App>/User/globalStorage/state.vscdb
 *   Windows  %APPDATA%\<App>\User\globalStorage\state.vscdb
 *   Linux    ~/.config/<App>/User/globalStorage/state.vscdb
 *   ItemTable key = history.recentlyOpenedPathsList
 *   value = {"entries":[{"folderUri":"file:///abs/path"},{"workspace":{"configPath":"file:///"}},{"fileUri":"..."}]}
 *
 * 读法：app 运行时会锁库，先复制 db + -wal 到 /tmp 再用 node:sqlite（没有则退回 sqlite3 CLI）。
 * 写入风险与时机见 research/03-vscode-forks-and-seeding.md。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copySqliteToTemp, isRunning, isRunningByCmdline, readJson } from '../lib/safety.mjs';
import { appDataCandidates, fileUriToPath, isAbsoluteAnyPlatform, openInAppPlan, pathModuleFor, resolveAppDataDir, runOpenPlan, spawnCliDetached } from '../lib/platform.mjs';

const RECENT_KEY = 'history.recentlyOpenedPathsList';

async function readItemTableValue(dbFile, key) {
  const { dbFile: tmp, cleanup } = copySqliteToTemp(dbFile);
  try {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(tmp);
      try {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
        if (!row) return { ok: false, error: 'key-not-found' };
        const raw = row.value;
        return { ok: true, value: typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8') };
      } finally {
        db.close();
      }
    } catch (nodeSqliteErr) {
      // Node < 22.5 或 sqlite 模块不可用：退回系统 sqlite3
      const r = spawnSync('sqlite3', ['-json', tmp, `SELECT value FROM ItemTable WHERE key='${key}'`], {
        encoding: 'utf8',
      });
      if (r.error) return { ok: false, error: String(r.error.message || r.error) };
      if (r.status !== 0) return { ok: false, error: String(r.stderr || '').trim() || 'sqlite3-failed' };
      try {
        const rows = JSON.parse(r.stdout || '[]');
        if (!rows.length) return { ok: false, error: 'key-not-found' };
        return { ok: true, value: String(rows[0].value ?? '') };
      } catch (e) {
        return { ok: false, error: 'sqlite3-parse: ' + String(e.message || e) };
      }
    }
  } finally {
    cleanup();
  }
}

/** 把 entries 转成统一条目；只收目录/工作区，不收单个文件 */
export function parseRecentEntries(value, { platform = process.platform } = {}) {
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    return [];
  }
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const P = pathModuleFor(platform); // 路径可能不是本机风格（测试/跨平台读取），按目标平台解析
  const out = [];
  entries.forEach((e, idx) => {
    if (e?.folderUri) {
      out.push({ path: fileUriToPath(e.folderUri, { platform }), order: idx });
    } else if (e?.workspace?.configPath) {
      // .code-workspace 文件 → 取所在目录作为项目
      const p = fileUriToPath(e.workspace.configPath, { platform });
      out.push({ path: p.endsWith('.code-workspace') ? P.dirname(p) : p, order: idx });
    }
  });
  return out;
}

/**
 * 读 VS Code 系的 workspaceStorage：里面有精确的 folder 路径 + state.vscdb mtime（= 最后活跃）。
 * 这是 recents 列表的“时间戳补丁”：recents 只有顺序没有时间，而本机 48 个遗忘项目的时间只在这里。
 */
export function readWorkspaceStorageEntries(dbFile, { platform = process.platform } = {}) {
  const P = pathModuleFor(platform);
  const userRoot = path.dirname(path.dirname(dbFile)); // <userData>/User
  const storageRoot = path.join(userRoot, 'workspaceStorage');
  let dirs = [];
  try {
    dirs = fs.readdirSync(storageRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    const dir = path.join(storageRoot, d.name);
    let ws;
    try {
      ws = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
    } catch {
      continue;
    }
    const raw = ws?.folder || ws?.workspace;
    if (typeof raw !== 'string') continue;
    let p = fileUriToPath(raw, { platform });
    if (p.endsWith('.code-workspace')) p = P.dirname(p);
    if (!isAbsoluteAnyPlatform(p)) continue;
    let lastActiveAt = null;
    try {
      lastActiveAt = fs.statSync(path.join(dir, 'state.vscdb')).mtimeMs;
    } catch {
      /* ignore */
    }
    out.push({ path: p, lastActiveAt, nativeId: d.name });
  }
  return out;
}

/**
 * 解析某 VS Code 系应用的 userData 目录（`<userData>/User/globalStorage/state.vscdb` 的上级）。
 * 优先用真实存在的候选目录；本机没装则退回第一个候选（statePaths 仍能给出“该去哪找”）。
 * 显式传 userDataDir 时原样使用（测试/非标准安装）。
 */
export function vsCodeUserDataDir({
  appName,
  userDataDir,
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (userDataDir) return userDataDir;
  const opts = { platform, env, homedir };
  const existing = resolveAppDataDir(appName, opts);
  if (existing) return existing;
  const [first] = appDataCandidates(appName, opts);
  return first || path.join(homedir, appName);
}

/** `<userData>/User/globalStorage/state.vscdb` 的完整路径 */
export function vsCodeStateDbPath({ appName, userDataDir, platform, env, homedir } = {}) {
  return path.join(vsCodeUserDataDir({ appName, userDataDir, platform, env, homedir }), 'User', 'globalStorage', 'state.vscdb');
}

export function createVsCodeAdapter({
  id,
  name,
  userDataDir,
  appName,
  cli,
  processNames = [],
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
}) {
  const dbFile = vsCodeStateDbPath({ appName, userDataDir, platform, env, homedir });
  return {
    id,
    name,
    kind: 'ide',
    capabilities: { read: true, seed: 'store-write', open: true, watch: true },
    statePaths: () => [dbFile],
    async read() {
      if (!fs.existsSync(dbFile)) return { entries: [], error: 'not-found', statePath: dbFile };
      const r = await readItemTableValue(dbFile, RECENT_KEY);
      if (!r.ok) return { entries: [], error: r.error, statePath: dbFile };
      const recents = parseRecentEntries(r.value, { platform }).map((e) => ({
        path: e.path,
        title: null,
        nativeId: null,
        lastActiveAt: null,
        order: e.order,
      }));
      // workspaceStorage 补时间：recents 只有顺序没有时间，这里能拿到精确 lastActive
      const storages = readWorkspaceStorageEntries(dbFile, { platform });
      const byPath = new Map();
      for (const e of recents) byPath.set(e.path.replace(/\/+$/, ''), e);
      let added = 0;
      for (const st of storages) {
        const key = st.path.replace(/\/+$/, '');
        const hit = byPath.get(key);
        if (hit) {
          if (!hit.lastActiveAt && st.lastActiveAt) hit.lastActiveAt = st.lastActiveAt;
        } else {
          byPath.set(key, { path: st.path, title: null, nativeId: st.nativeId, lastActiveAt: st.lastActiveAt, order: recents.length + added++ });
        }
      }
      const entries = [...byPath.values()];
      return { entries, statePath: dbFile, note: `${recents.length} 条最近 + ${storages.length} 个 workspaceStorage` };
    },
    async isRunning() {
      const byName = isRunning([...processNames, ...(cli ? [cli] : [])]);
      if (byName === true) return true;
      // 进程探测口径按平台：macOS 看 .app 路径，Windows 看 exe 名
      const patterns = platform === 'win32' ? [`${appName}.exe`, `${appName}\\`] : [`${appName}.app/Contents`];
      return isRunningByCmdline(patterns);
    },
    async open(target) {
      if (cli) {
        spawnCliDetached(cli, [target], { platform, env });
        return { ok: true, how: `${cli} ${target}` };
      }
      const plan = openInAppPlan(appName, target, { platform });
      if (!plan) return { ok: false, error: '缺少目标目录' };
      runOpenPlan(plan, { platform });
      return { ok: true, how: plan.how };
    },
  };
}

export const trae = (opts = {}) =>
  createVsCodeAdapter({
    id: 'trae',
    name: 'Trae',
    appName: 'Trae',
    cli: 'trae',
    processNames: ['Trae'],
    ...opts,
  });

export const cursor = (opts = {}) =>
  createVsCodeAdapter({
    id: 'cursor',
    name: 'Cursor',
    appName: 'Cursor',
    cli: 'cursor',
    processNames: ['Cursor'],
    ...opts,
  });

/**
 * Google Antigravity（VS Code fork）。
 * recon C 实测同源：同一 ItemTable key、同样 entries 结构、每类上限 500 条。
 * 无公开 CLI，打开走平台默认方式（macOS `open -a` / Windows `start` / Linux `xdg-open`）。
 */
export const antigravity = (opts = {}) =>
  createVsCodeAdapter({
    id: 'antigravity',
    name: 'Antigravity',
    appName: 'Antigravity',
    cli: null,
    processNames: ['Antigravity'],
    ...opts,
  });
