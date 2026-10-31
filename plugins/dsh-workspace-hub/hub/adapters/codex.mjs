/**
 * Codex 适配器（Codex 桌面版的项目列表）
 *
 * 真相源（recon A 实测，2026-10-29）：
 *   ~/.codex/state_5.sqlite  ← app-server 拥有的领域库，**唯一真相源**
 *     projects(id TEXT PK, name TEXT, metadata TEXT JSON, position INTEGER, created_at_ms, updated_at_ms)
 *     project_roots(project_id, position, path)   ← 一个项目可挂多个根目录
 *     project_idempotency_keys(key, project_id, created_at_ms)  ← 删除会留墓碑
 *
 *   ~/.codex/.codex-global-state.json（local-projects / project-order / electron-saved-workspace-roots）
 *   只是**镜像 + 旧迁移态**：桌面版启动时用 app-server 数据反向刷新它；手改它可能被覆盖，
 *   甚至因 server 没有而被 project/import 反向导入，产生重复项目。→ 只作为 sqlite 不可用时的降级读取。
 *
 * 播种（S1，官方接口）：
 *   关掉 Codex → 起 `codex app-server`（stdio JSONL）→
 *   `initialize{capabilities:{experimentalApi:true}}` → `project/create {name, roots:[{path}], idempotencyKey}`
 *   （recon A 已在隔离 CODEX_HOME 副本上全链路实测 create→update→move→delete 通过）
 *   app 运行中外部写库不会刷新侧栏（桌面版只认自己 app-server 的 project/changed 通知）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, isRunningByCmdline } from '../lib/safety.mjs';
import { spawnCliDetached } from '../lib/platform.mjs';
import { querySqlite } from '../lib/sqlite.mjs';

const HOME = os.homedir();
const DB = path.join(HOME, '.codex', 'state_5.sqlite');
const STATE = path.join(HOME, '.codex', '.codex-global-state.json');

/** 从 state_5.sqlite 读；失败返回 null，由调用方降级到 JSON 镜像 */
async function readFromSqlite() {
  if (!fs.existsSync(DB)) return null;
  const projectsRes = await querySqlite(
    DB,
    'SELECT id, name, position, created_at_ms, updated_at_ms FROM projects ORDER BY position'
  );
  if (!projectsRes.ok) return null;
  const rootsRes = await querySqlite(
    DB,
    'SELECT project_id, position, path FROM project_roots ORDER BY project_id, position'
  );
  if (!rootsRes.ok) return null;

  const rootsByProject = new Map();
  for (const r of rootsRes.rows) {
    if (!r.project_id || !r.path) continue;
    if (!rootsByProject.has(r.project_id)) rootsByProject.set(r.project_id, []);
    rootsByProject.get(r.project_id).push(r);
  }

  const entries = [];
  for (const p of projectsRes.rows) {
    const roots = rootsByProject.get(p.id) || [];
    for (const r of roots) {
      entries.push({
        path: r.path,
        title: p.name || null,
        nativeId: p.id,
        lastActiveAt: p.updated_at_ms || p.created_at_ms || null,
        order: p.position,
      });
    }
  }
  return { entries, statePath: DB, note: `${projectsRes.rows.length} 个项目（state_5.sqlite）` };
}

/** 降级：读 Electron JSON 镜像（旧版本/库不可用时） */
function readFromJsonMirror() {
  const r = readJson(STATE);
  if (!r.ok) return { entries: [], error: r.error, statePath: STATE };
  const d = r.value || {};
  const projects = d['local-projects'] || {};
  const order = Array.isArray(d['project-order']) ? d['project-order'] : [];
  const entries = [];
  const seen = new Set();
  const pushProject = (id, idx) => {
    const p = projects[id];
    if (!p) return;
    const roots = Array.isArray(p.rootPaths) ? p.rootPaths : [];
    for (const root of roots) {
      if (!root || seen.has(root)) continue;
      seen.add(root);
      entries.push({
        path: root,
        title: p.name || null,
        nativeId: id,
        lastActiveAt: p.updatedAt || p.createdAt || null,
        order: idx,
      });
    }
  };
  order.forEach((id, i) => pushProject(id, i));
  let extra = order.length;
  for (const id of Object.keys(projects)) {
    if (!order.includes(id)) pushProject(id, extra++);
  }
  let folderOrder = extra;
  const roots = Array.isArray(d['electron-saved-workspace-roots']) ? d['electron-saved-workspace-roots'] : [];
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    entries.push({ path: root, title: null, nativeId: null, lastActiveAt: null, order: folderOrder++ });
  }
  return { entries, statePath: STATE, note: `JSON 镜像降级：${Object.keys(projects).length} 个项目` };
}

export default {
  id: 'codex-app',
  name: 'Codex',
  kind: 'agent',
  capabilities: { read: true, seed: 'rpc', open: true, watch: true },
  statePaths: () => [DB, STATE],

  async read() {
    const fromDb = await readFromSqlite();
    if (fromDb) return fromDb;
    return readFromJsonMirror();
  },

  async isRunning() {
    // 本机 Codex 桌面版跑在 /Applications/ChatGPT.app 的 Codex Framework 里，进程名不是 Codex。
    // Windows 上是 ChatGPT.exe（Store 版）或 Codex.exe（独立安装）。
    const patterns = process.platform === 'win32'
      ? ['ChatGPT.exe', 'Codex.exe', 'codex app-server']
      : ['ChatGPT.app/Contents/Frameworks/Codex Framework', 'codex app-server'];
    return isRunningByCmdline(patterns);
  },

  /** 官方入口：codex app <path>，在桌面版里打开该工作目录 */
  async open(target) {
    spawnCliDetached('codex', ['app', target]);
    return { ok: true, how: `codex app ${target}` };
  },
};
