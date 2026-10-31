/**
 * 第二批适配器：盘点（research/05）里发现、但不在第一批 8 个里的 AI 工具。
 *
 * 每一条都对应报告里的“最小读取配方”，全部只读、容错（读不到就返回 error，不抛）。
 *
 * 覆盖：
 *   kimi          ~/.kimi/kimi.json → work_dirs[]（17 条，时间靠 md5(path) 会话目录 mtime）
 *   uking         ~/.uking/tasks.json → tasks[].dir + last_opened_at（自有产品，自带时间）
 *   qwenwork      ~/.qwenworkcn/projects/<enc>/*.jsonl 首行 workspace-directories → directories[]
 *   codebuddy     ~/.codebuddy/projects/<enc>/*.jsonl 首行 cwd
 *   pi            ~/.pi/agent/sessions/<enc>/*.jsonl 首行 cwd + timestamp
 *   qoder         ~/.qoder/projects/<enc>/*.jsonl 首行 cwd + timestamp
 *   deepseek-tui  ~/.deepseek/sessions/*.json → metadata.workspace + updated_at
 *   hermes        ~/.hermes/state.db → sessions(cwd, started_at)（只读，没有可写的项目列表）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, isRunningByCmdline } from '../lib/safety.mjs';
import { querySqlite } from '../lib/sqlite.mjs';
import { isAbsoluteAnyPlatform, isTempScratch, isUnderPath } from '../lib/platform.mjs';

const HOME = os.homedir();

function safeReaddir(dir, opts) {
  try {
    return fs.readdirSync(dir, opts);
  } catch {
    return [];
  }
}

function latestMtimeMs(paths) {
  let max = 0;
  for (const p of paths) {
    try {
      const s = fs.statSync(p);
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch {
      /* ignore */
    }
  }
  return max || null;
}

function walkFiles(dir, maxDepth = 2) {
  const files = [];
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: d, depth } = stack.pop();
    for (const e of safeReaddir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      else if (e.isFile()) files.push(full);
    }
  }
  return files;
}

/** 读 JSONL 文件首行（截断保护，不整文件读） */
function readFirstJsonLine(file, maxBytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const nl = text.indexOf('\n');
      const line = (nl >= 0 ? text.slice(0, nl) : text).trim();
      return line ? JSON.parse(line) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function baseEntry({ p, title, lastActiveAt, nativeId, order, kind }) {
  return { path: p, title: title || path.basename(p) || null, nativeId: nativeId || null, lastActiveAt: lastActiveAt || null, order, kind: kind || 'project' };
}

// ---------------------------------------------------------------------------
// Kimi CLI
// ---------------------------------------------------------------------------
export const kimi = {
  id: 'kimi',
  name: 'Kimi CLI',
  kind: 'agent',
  capabilities: { read: true, seed: 'store-write', open: false, watch: true },
  statePaths: () => [path.join(HOME, '.kimi', 'kimi.json'), path.join(HOME, '.kimi', 'sessions')],
  async read() {
    const state = path.join(HOME, '.kimi', 'kimi.json');
    const r = readJson(state);
    if (!r.ok) return { entries: [], error: r.error, statePath: state };
    const dirs = Array.isArray(r.value?.work_dirs) ? r.value.work_dirs : [];
    const sessionsRoot = path.join(HOME, '.kimi', 'sessions');
    const entries = dirs
      .filter((d) => d && typeof d.path === 'string' && isAbsoluteAnyPlatform(d.path))
      .map((d, i) => {
        const md5 = crypto.createHash('md5').update(d.path).digest('hex');
        const sessDir = path.join(sessionsRoot, md5);
        const last = latestMtimeMs(walkFiles(sessDir, 2));
        return baseEntry({ p: d.path, lastActiveAt: last, nativeId: md5, order: i, kind: isTempScratch(d.path) ? 'app-managed' : 'project' });
      })
      // 同一路径去重
      .filter((e, i, arr) => arr.findIndex((x) => x.path === e.path) === i);
    return { entries, statePath: state, note: `${entries.length} 个工作目录` };
  },
  async isRunning() {
    return isRunningByCmdline(['kimi', '/@moonshot-ai/kimi-cli']);
  },
};

// ---------------------------------------------------------------------------
// U-King（用户自有产品，列表语义最接近工作台）
// ---------------------------------------------------------------------------
export const uking = {
  id: 'uking',
  name: 'U-King',
  kind: 'agent',
  capabilities: { read: true, seed: 'cli', open: false, watch: true },
  statePaths: () => [path.join(HOME, '.uking', 'tasks.json')],
  async read() {
    const state = path.join(HOME, '.uking', 'tasks.json');
    const r = readJson(state);
    if (!r.ok) return { entries: [], error: r.error, statePath: state };
    const tasks = Array.isArray(r.value?.tasks) ? r.value.tasks : [];
    const byPath = new Map();
    tasks.forEach((t) => {
      if (!t || typeof t.dir !== 'string' || !isAbsoluteAnyPlatform(t.dir)) return;
      const prev = byPath.get(t.dir);
      const ts = t.last_opened_at || null;
      if (!prev || (ts || 0) > (prev.lastActiveAt || 0)) {
        byPath.set(t.dir, baseEntry({ p: t.dir, title: t.name, lastActiveAt: ts, nativeId: t.id, order: prev?.order ?? byPath.size }));
      }
    });
    const entries = [...byPath.values()];
    return { entries, statePath: state, note: `${entries.length} 个任务工作目录` };
  },
  async isRunning() {
    return isRunningByCmdline(['U-King.app', 'u-king-mini']);
  },
};

// ---------------------------------------------------------------------------
// QwenWorkCN CLI（首行 workspace-directories 免解码）
// ---------------------------------------------------------------------------
export const qwenwork = {
  id: 'qwenwork',
  name: 'QwenWork',
  kind: 'agent',
  capabilities: { read: true, seed: 'store-write', open: false, watch: true },
  statePaths: () => [path.join(HOME, '.qwenworkcn', 'projects')],
  async read() {
    const root = path.join(HOME, '.qwenworkcn', 'projects');
    const byPath = new Map();
    for (const enc of safeReaddir(root, { withFileTypes: true })) {
      if (!enc.isDirectory()) continue;
      const dir = path.join(root, enc.name);
      for (const f of safeReaddir(dir).filter((n) => n.endsWith('.jsonl'))) {
        const file = path.join(dir, f);
        const head = readFirstJsonLine(file);
        if (!head || head.type !== 'workspace-directories' || !Array.isArray(head.directories)) continue;
        for (const p of head.directories) {
          if (typeof p !== 'string' || !isAbsoluteAnyPlatform(p)) continue;
          const appManaged = isUnderPath(p, path.join(HOME, '.qwenworkcn', 'workspace')) || isTempScratch(p);
          const prev = byPath.get(p);
          const ts = latestMtimeMs([file]);
          if (!prev) byPath.set(p, baseEntry({ p, lastActiveAt: ts, order: byPath.size, kind: appManaged ? 'app-managed' : 'project' }));
          else if ((ts || 0) > (prev.lastActiveAt || 0)) prev.lastActiveAt = ts;
        }
      }
    }
    const entries = [...byPath.values()];
    return { entries, statePath: root, note: `${entries.length} 个目录` };
  },
  async isRunning() {
    return isRunningByCmdline(['qwenwork', 'QwenWorkCN.app']);
  },
};

// ---------------------------------------------------------------------------
// 通用 JSONL 会话型工具（Claude Code 同构）：CodeBuddy / pi / Qoder
// ---------------------------------------------------------------------------
function createSessionJsonlAdapter({ id, name, rootDirs, processPatterns }) {
  return {
    id,
    name,
    kind: 'agent',
    capabilities: { read: true, seed: 'store-write', open: false, watch: true },
    statePaths: () => rootDirs,
    async read() {
      const byPath = new Map();
      for (const root of rootDirs) {
        for (const enc of safeReaddir(root, { withFileTypes: true })) {
          if (!enc.isDirectory()) continue;
          const dir = path.join(root, enc.name);
          const files = safeReaddir(dir).filter((n) => n.endsWith('.jsonl'));
          for (const f of files) {
            const file = path.join(dir, f);
            const head = readFirstJsonLine(file);
            const cwd = head?.cwd;
            if (typeof cwd !== 'string' || !isAbsoluteAnyPlatform(cwd)) continue;
            const ts = head.timestamp ? new Date(head.timestamp).getTime() : latestMtimeMs([file]);
            const prev = byPath.get(cwd);
            if (!prev) {
              byPath.set(cwd, baseEntry({ p: cwd, lastActiveAt: ts, nativeId: head.sessionId || null, order: byPath.size, kind: isTempScratch(cwd) ? 'app-managed' : 'project' }));
            } else if ((ts || 0) > (prev.lastActiveAt || 0)) prev.lastActiveAt = ts;
          }
        }
      }
      const entries = [...byPath.values()];
      return { entries, statePath: rootDirs[0] || null, note: `${entries.length} 个会话目录` };
    },
    async isRunning() {
      return isRunningByCmdline(processPatterns);
    },
  };
}

export const codebuddy = () =>
  createSessionJsonlAdapter({
    id: 'codebuddy',
    name: 'CodeBuddy',
    rootDirs: [path.join(HOME, '.codebuddy', 'projects')],
    processPatterns: ['codebuddy', 'cbc'],
  });

export const pi = () =>
  createSessionJsonlAdapter({
    id: 'pi',
    name: 'pi CLI',
    rootDirs: [path.join(HOME, '.pi', 'agent', 'sessions')],
    processPatterns: ['/pi-coding-agent'],
  });

export const qoder = () =>
  createSessionJsonlAdapter({
    id: 'qoder',
    name: 'Qoder',
    rootDirs: [path.join(HOME, '.qoder', 'projects')],
    processPatterns: ['qodercli', 'Qoder.app'],
  });

// ---------------------------------------------------------------------------
// DeepSeek TUI（会话 JSON 里带 metadata.workspace）
// ---------------------------------------------------------------------------
export const deepseekTui = {
  id: 'deepseek-tui',
  name: 'DeepSeek TUI',
  kind: 'agent',
  capabilities: { read: true, seed: 'store-write', open: false, watch: true },
  statePaths: () => [path.join(HOME, '.deepseek', 'sessions')],
  async read() {
    const root = path.join(HOME, '.deepseek', 'sessions');
    const byPath = new Map();
    for (const f of safeReaddir(root).filter((n) => n.endsWith('.json'))) {
      const r = readJson(path.join(root, f));
      if (!r.ok) continue;
      const meta = r.value?.metadata || {};
      const p = meta.workspace;
      if (typeof p !== 'string' || !isAbsoluteAnyPlatform(p)) continue;
      const ts = meta.updated_at ? new Date(meta.updated_at).getTime() : null;
      const prev = byPath.get(p);
      if (!prev) byPath.set(p, baseEntry({ p, title: meta.title, lastActiveAt: ts, nativeId: meta.id, order: byPath.size }));
      else if ((ts || 0) > (prev.lastActiveAt || 0)) prev.lastActiveAt = ts;
    }
    const entries = [...byPath.values()];
    return { entries, statePath: root, note: `${entries.length} 个工作目录` };
  },
  async isRunning() {
    return isRunningByCmdline(['deepseek']);
  },
};

// ---------------------------------------------------------------------------
// Hermes（SQLite 只读：没有可写的“项目列表”，只能读会话 cwd）
// ---------------------------------------------------------------------------
export const hermes = {
  id: 'hermes',
  name: 'Hermes',
  kind: 'agent',
  capabilities: { read: true, seed: 'none', open: false, watch: true },
  statePaths: () => [path.join(HOME, '.hermes', 'state.db')],
  async read() {
    const db = path.join(HOME, '.hermes', 'state.db');
    if (!fs.existsSync(db)) return { entries: [], error: 'not-found', statePath: db };
    const res = await querySqlite(
      db,
      "SELECT cwd, MAX(started_at) AS last, COUNT(*) AS n, MAX(title) AS title FROM sessions WHERE cwd IS NOT NULL AND cwd != '' GROUP BY cwd ORDER BY last DESC"
    );
    if (!res.ok) return { entries: [], error: res.error, statePath: db };
    const entries = res.rows.map((row, i) =>
      baseEntry({ p: row.cwd, title: row.title, lastActiveAt: row.last, order: i, kind: isTempScratch(row.cwd) ? 'app-managed' : 'project' })
    );
    return { entries, statePath: db, note: `${entries.length} 个工作目录（${res.rows.reduce((s, r) => s + (r.n || 0), 0)} 个会话）` };
  },
  async isRunning() {
    return isRunningByCmdline(['Hermes.app', '/hermes']);
  },
};
