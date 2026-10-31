/**
 * 账本（ledger）：所有工具的工作目录的“并集真相源”。
 *
 * 为什么要有账本，而不是每次现算：
 *   - 各工具的列表上限不同（VS Code 最近列表会被挤掉），单看任何一个都看不全
 *   - 某些工具（豆包/WorkBuddy）可能只能读不能写，账本是唯一可靠的“总账”
 *   - 云端同步时只同步这一份账本 + 事件日志，不需要同步各工具的私有格式
 *
 * 条目结构（workspace）：
 * {
 *   id, key, path, displayName, pinned, group,
 *   firstSeenAt, lastActiveAt,
 *   presentIn: ["dsh","codex-app",...],       // 本次扫描里哪些工具含有它
 *   sources: { dsh: { nativeId, title, order, lastSeenAt } }
 * }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, pathKey, stableId, defaultTitle } from './paths.mjs';
import { atomicWriteJson, appendJsonl, ensureDir, nowIso, readJson } from './safety.mjs';

export const LEDGER_VERSION = 1;

/** 这些不是“用户项目”：AI 工具的数据目录、盘根/家目录级目录。跨设备事件里常被误登记成 project。 */
const DATA_LIKE_RE = /(^|\/)(\.codex|\.hermes|\.dsh\/imports|\.ssh|DoubaoWork|AiToolData|AppData)(\/|$)|^\/[^/]+\/(Desktop|Documents|Downloads|claude|code)$/
export function isDataLikePath(p) {
  return typeof p === 'string' && DATA_LIKE_RE.test(p)
}

/** 默认不入账的“伪工作目录”：家目录本身、文件系统根。侧栏里出现 ~ 是噪音，也不能播种 */
export function defaultIgnoredPaths() {
  const home = os.homedir();
  return [home, path.parse(home).root].map((p) => pathKey(p));
}

export function dataPaths(home) {
  return {
    dir: home,
    ledger: path.join(home, 'ledger.json'),
    events: path.join(home, 'events.jsonl'),
    backups: path.join(home, 'backups'),
  };
}

export function emptyLedger() {
  return { version: LEDGER_VERSION, updatedAt: null, workspaces: [] };
}

export function loadLedger(home) {
  const r = readJson(dataPaths(home).ledger);
  if (!r.ok || !r.value || !Array.isArray(r.value.workspaces)) {
    return { ledger: emptyLedger(), error: r.ok ? 'invalid-shape' : r.error };
  }
  return { ledger: r.value, error: null };
}

export function saveLedger(home, ledger) {
  ensureDir(dataPaths(home).dir);
  ledger.updatedAt = nowIso();
  atomicWriteJson(dataPaths(home).ledger, ledger);
}

export function appendEvent(home, event) {
  appendJsonl(dataPaths(home).events, { at: nowIso(), ...event });
}

/** 时间戳统一成可比较的 ISO 字符串；接受 ISO / 毫秒 / 秒 */
export function normalizeTimestamp(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const ms = ts > 1e12 ? ts : ts > 1e9 ? ts * 1000 : null;
    return ms ? new Date(ms).toISOString() : null;
  }
  if (typeof ts === 'string') {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    const n = Number(ts);
    if (Number.isFinite(n)) return normalizeTimestamp(n);
  }
  return null;
}

function compareWorkspaces(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const ta = a.lastActiveAt || '';
  const tb = b.lastActiveAt || '';
  if (ta !== tb) return ta < tb ? 1 : -1;
  return String(a.path).localeCompare(String(b.path), 'zh-CN');
}

/**
 * 把本轮所有工具读到的观测合并进账本。
 * observations: [{ tool, path, title?, nativeId?, lastActiveAt?, order? }]
 * opts.toolsSeen: 本轮“成功读到”的工具 id 列表；只有它们有资格被从 presentIn 里移除
 * （读失败的工具不能判定用户删了项目）
 */
export function mergeObservations(ledger, observations, opts = {}) {
  const { now = nowIso(), toolsSeen = [], ignorePaths = defaultIgnoredPaths() } = opts;
  const ignored = new Set(ignorePaths);
  const byKey = new Map();
  for (const ws of ledger.workspaces) {
    byKey.set(ws.key, {
      ...ws,
      sources: { ...(ws.sources || {}) },
      presentIn: Array.isArray(ws.presentIn) ? [...ws.presentIn] : [],
    });
  }

  const changes = { added: [], touched: [], relinked: [], ignored: 0 };
  const seenThisRound = new Set();
  const observedByTool = new Map(); // toolId -> Set<pathKey>，用于判定“这个工具这轮是不是真的有它”

  for (const ob of observations) {
    const canon = canonicalPath(ob.path);
    if (!canon) continue;
    const key = pathKey(canon);
    if (!key) continue;
    if (ignored.has(key)) {
      changes.ignored++;
      continue;
    }
    if (!observedByTool.has(ob.tool)) observedByTool.set(ob.tool, new Set());
    observedByTool.get(ob.tool).add(key);
    let ws = byKey.get(key);
    if (!ws) {
      ws = {
        id: stableId(key),
        key,
        path: canon,
        displayName: ob.title || defaultTitle(canon),
        kind: ob.kind || 'project',
        pinned: false,
        group: null,
        firstSeenAt: now,
        lastActiveAt: null,
        presentIn: [],
        sources: {},
      };
      byKey.set(key, ws);
      changes.added.push(ws);
    }
    // kind 优先级：只要有任一工具把它当“用户项目”(project)，就按 project 处理。
    // app-managed 表示“某个 app 自己生成的任务目录”（WorkBuddy 时间戳目录、Claude scratch），
    // 这类目录默认不播种给别的工具，免得污染它们的侧栏。
    if (ob.kind === 'project') ws.kind = 'project';
    else if (!ws.kind && ob.kind) ws.kind = ob.kind;
    if (isDataLikePath(ws.path)) ws.kind = 'app-managed';
    if (!ws.presentIn.includes(ob.tool)) ws.presentIn.push(ob.tool);
    const ts = normalizeTimestamp(ob.lastActiveAt);
    if (ts && (!ws.lastActiveAt || ts > ws.lastActiveAt)) ws.lastActiveAt = ts;
    ws.sources[ob.tool] = {
      ...(ws.sources[ob.tool] || {}),
      nativeId: ob.nativeId ?? ws.sources[ob.tool]?.nativeId ?? null,
      title: ob.title ?? ws.sources[ob.tool]?.title ?? null,
      order: ob.order ?? ws.sources[ob.tool]?.order ?? null,
      lastSeenAt: now,
    };
    seenThisRound.add(key);
  }

  // 本轮没被某个“成功读取的工具”再次看到的条目：从该工具的 presentIn 里摘掉。
  // 只对成功扫描的工具做，读失败的工具没有资格被摘（避免误判用户删了项目）。
  const seenTools = new Set(toolsSeen);
  for (const [key, ws] of byKey) {
    const before = ws.presentIn.length;
    ws.presentIn = ws.presentIn.filter(
      (t) => !seenTools.has(t) || Boolean(observedByTool.get(t)?.has(key))
    );
    if (ws.presentIn.length !== before) changes.relinked.push(ws);
  }

  ledger.workspaces = [...byKey.values()].sort(compareWorkspaces);
  ledger.updatedAt = now;
  return { ledger, changes };
}

/**
 * 某个工具缺哪些账本里的目录（= 可以播种给它的候选）。
 * includeKinds：默认只播种“用户项目”，不把 app 自己生成的任务目录塞给别人。
 */
export function planForTool(ledger, toolId, { limit = 20, requireExists = true, includeKinds = ['project'] } = {}) {
  const missing = ledger.workspaces
    .filter((ws) => !ws.presentIn.includes(toolId))
    .filter((ws) => includeKinds.includes(ws.kind || 'project'))
    .filter((ws) => !requireExists || fs.existsSync(ws.path))
    .slice(0, limit);
  return missing;
}

/** 统计：并集、每工具覆盖、单工具孤儿、僵尸目录、app 托管目录 */
export function summarize(ledger) {
  const total = ledger.workspaces.length;
  const perTool = new Map();
  const orphans = [];
  const missingDirs = [];
  const appManaged = [];
  for (const ws of ledger.workspaces) {
    for (const t of ws.presentIn) perTool.set(t, (perTool.get(t) || 0) + 1);
    if (ws.presentIn.length === 1) orphans.push(ws);
    if (!fs.existsSync(ws.path)) missingDirs.push(ws);
    if (ws.kind === 'app-managed') appManaged.push(ws);
  }
  return { total, perTool, orphans, missingDirs, appManaged };
}
