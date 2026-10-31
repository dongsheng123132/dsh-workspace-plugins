/**
 * 跨设备同步内核：HLC + 追加式事件日志 + 合并 + 传输抽象。
 *
 * 设计目标（docs/DESIGN.md §10、docs/CROSS-DEVICE.md）：
 *   1. 只同步「账本 + 事件日志」，不同步任何 app 的私有状态文件（KB 级、明文可审计、可重建）；
 *   2. 事件源溯源：add / remove / pin / touch / title / kind 六种 op 追加写入 events.jsonl；
 *   3. 冲突模型：per-item LWW（HLC 排序 + deviceId 决平局）+ tombstone 删除不复活 + 只加不减；
 *   4. 合并是幂等的集合运算，不需要锁——被重复收集、重复 publish 都不改变结果；
 *   5. 传输层只假设「有一个大家都能读写的目录」：devices/<deviceId>/events.jsonl。
 *      iCloud / Syncthing / Git / 自建服务都可以套在这个抽象下面。
 *
 * 本地事件日志 = <home>/events.jsonl（与 hub/lib/ledger.mjs dataPaths().events 同路径）。
 *   同步事件靠 `op ∈ SYNCABLE_OPS` + `hlc` 识别；其它形状的行（历史观测事件）会被忽略并计数，
 *   不会让合并失败，也不会被当成删除。
 * 本地时钟状态 = <home>/sync-clock.json，保证本地事件 HLC 单调递增（时钟回退也不会倒退）。
 *
 * 边界：本模块不写 ledger.json，也不碰任何 app 状态文件——保存合并结果是调用方（CLI）的事。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  loadDevice,
  resolveHubHome,
  identityForPath,
  identityFromRoot,
  foreignIdentity,
  fromRelPath,
  normalizeRelPath,
  normalizeRootId,
} from './device.mjs';
import { canonicalPath, pathKey, stableId, defaultTitle } from './paths.mjs';
import { emptyLedger, loadLedger, normalizeTimestamp, LEDGER_VERSION } from './ledger.mjs';
import { appendJsonl, atomicWriteJson, ensureDir, nowIso, readJson } from './safety.mjs';

export const SYNC_VERSION = 1;
/** 可同步的 op；不在这张表里的行会被忽略（兼容历史事件/别家写的日志） */
export const SYNCABLE_OPS = ['add', 'remove', 'pin', 'touch', 'title', 'kind'];
export const DEVICES_DIR = 'devices';
export const EVENTS_FILE = 'events.jsonl';
export const DEVICE_INFO_FILE = 'device.json';
export const SNAPSHOT_FILE = 'ledger.snapshot.json';
export const CLOCK_FILE = 'sync-clock.json';

/** 共享同步目录的环境变量（CLI 接线用；显式 --sync-dir 参数优先） */
export const SYNC_DIR_ENV_VARS = ['WSHUB_SYNC_DIR', 'WDHUB_SYNC_DIR'];

/**
 * 解析共享同步目录：显式参数 > 环境变量 > macOS 默认 iCloud Drive 路径。
 * 其它平台没有“开箱即用”的共享目录，返回 null 由调用方提示用户配置。
 */
export function resolveSyncDir({ dir, env = process.env, homedir = os.homedir() } = {}) {
  if (dir) return path.resolve(String(dir));
  for (const key of SYNC_DIR_ENV_VARS) {
    const value = env?.[key];
    if (value) return path.resolve(value);
  }
  if (process.platform === 'darwin') {
    return path.join(homedir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'workspace-hub');
  }
  return null;
}

/** 本地文件位置（home 参数一律显式传入，测试用临时目录） */
export function syncPaths(home) {
  const dir = home ? path.resolve(String(home)) : resolveHubHome();
  return {
    home: dir,
    events: path.join(dir, EVENTS_FILE),
    clock: path.join(dir, CLOCK_FILE),
  };
}

/** 共享同步目录里某台设备的事件日志路径 */
export function deviceLogPath(syncDir, deviceId) {
  return path.join(path.resolve(String(syncDir)), DEVICES_DIR, String(deviceId), EVENTS_FILE);
}

// ---------------------------------------------------------------------------
// HLC：混合逻辑时钟
// ---------------------------------------------------------------------------
// 格式：<15 位毫秒>:<6 位计数器>:<deviceId>，定宽字段保证字符串字典序 = 逻辑时间序；
// deviceId 在尾部，天然负责「同一毫秒同一计数器」的跨设备平局。
// 为什么不用纯时间戳：设备时钟可能不准/回退；HLC = 物理时间 + 逻辑计数器，
// 时钟回退时计数器和最大已知时间兜底，保证本机事件永远单调。

const HLC_RE = /^(\d{15}):(\d{6}):(.+)$/;

export function formatHlc(ms, counter, deviceId) {
  const m = Math.max(0, Math.floor(Number(ms) || 0));
  const c = Math.max(0, Math.floor(Number(counter) || 0));
  return `${String(m).padStart(15, '0')}:${String(c).padStart(6, '0')}:${String(deviceId || 'unknown')}`;
}

export function parseHlc(hlc) {
  if (typeof hlc !== 'string') return null;
  const m = HLC_RE.exec(hlc);
  if (!m) return null;
  return { ms: Number(m[1]), counter: Number(m[2]), device: m[3] };
}

/** 比较两个 HLC：<0 / 0 / >0；非法 HLC 视为最旧 */
export function compareHlc(a, b) {
  const pa = parseHlc(a);
  const pb = parseHlc(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.ms !== pb.ms) return pa.ms < pb.ms ? -1 : 1;
  if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1;
  return pa.device < pb.device ? -1 : pa.device > pb.device ? 1 : 0;
}

export function maxHlc(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return compareHlc(a, b) >= 0 ? a : b;
}

/**
 * 事件排序键：有合法 HLC 就用 HLC；老事件没有 HLC 时用 at 合成一个（计数器 0），
 * 再没有就当作最旧。保证 merge 对任意输入顺序都有确定结果。
 */
export function eventOrderKey(event) {
  const ev = event || {};
  if (parseHlc(ev.hlc)) return ev.hlc;
  const at = normalizeTimestamp(ev.at);
  const ms = at ? Date.parse(at) : 0;
  return formatHlc(Number.isFinite(ms) ? ms : 0, 0, ev.device || 'unknown');
}

/**
 * 逻辑时钟。tick() 生成严格递增的本地 HLC；observe() 在合并时把远端 HLC 纳入（取 max）。
 * now 可注入，方便测试时钟回退。
 */
export function createClock({ deviceId, state = null, now = () => Date.now() } = {}) {
  const id = String(deviceId || 'unknown');
  let ms = Number.isFinite(state?.ms) ? state.ms : 0;
  let counter = Number.isFinite(state?.counter) ? state.counter : 0;
  return {
    deviceId: id,
    tick() {
      const wall = Math.max(0, Math.floor(Number(now()) || 0));
      if (wall > ms) {
        ms = wall;
        counter = 0;
      } else {
        // 时钟回退 / 同一毫秒：只加计数器，保证严格递增
        counter += 1;
        if (counter > 999999) {
          ms += 1;
          counter = 0;
        }
      }
      return formatHlc(ms, counter, id);
    },
    /** 把远端 HLC 纳入本地时钟；返回时钟是否被推进 */
    observe(hlc) {
      const p = parseHlc(hlc);
      if (!p) return false;
      if (p.ms > ms) {
        ms = p.ms;
        counter = p.counter;
        return true;
      }
      if (p.ms === ms && p.counter > counter) {
        counter = p.counter;
        return true;
      }
      return false;
    },
    snapshot() {
      return { version: SYNC_VERSION, device: id, ms, counter, hlc: formatHlc(ms, counter, id) };
    },
  };
}

export function loadClock(home, deviceId) {
  const file = syncPaths(home).clock;
  const r = readJson(file);
  const state = r.ok && r.value && typeof r.value === 'object' ? r.value : null;
  return createClock({ deviceId, state });
}

export function saveClock(home, clock) {
  const file = syncPaths(home).clock;
  ensureDir(path.dirname(file));
  atomicWriteJson(file, { ...clock.snapshot(), updatedAt: nowIso() });
}

// ---------------------------------------------------------------------------
// 事件：构造 / 校验 / 指纹
// ---------------------------------------------------------------------------

/** 稳定序列化（键排序），事件指纹用 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      parts.push(JSON.stringify(key) + ':' + canonicalJson(value[key]));
    }
    return '{' + parts.join(',') + '}';
  }
  const json = JSON.stringify(value);
  return json === undefined ? 'null' : json;
}

/**
 * 事件指纹：内容 hash。用于「重复事件幂等」——
 * 同一条事件被重复追加、被多台设备手工复制、同步工具复制了文件，指纹都相同，只算一次。
 */
export function eventFingerprint(event) {
  const ev = event || {};
  const material = canonicalJson({
    v: ev.v ?? SYNC_VERSION,
    device: ev.device ?? '',
    hlc: ev.hlc ?? '',
    at: ev.at ?? '',
    op: ev.op ?? '',
    syncId: ev.syncId ?? '',
    tombstone: ev.tombstone === true,
    data: ev.data ?? {},
  });
  return 'ev_' + crypto.createHash('sha1').update(material).digest('hex').slice(0, 16);
}

function sanitizeEventData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || typeof value === 'function') continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return out;
}

/**
 * 构造一条规范事件（纯函数）。device 可以是设备对象或 deviceId 字符串。
 * 身份优先级：显式 syncId > rootId+relPath > path（本机 roots 映射 > 设备专属 foreign id）。
 */
export function makeEvent(device, spec = {}, { hlc = null, at = null } = {}) {
  const dev = typeof device === 'string' ? { id: device, roots: [] } : device || {};
  const deviceId = String(dev.id || dev.deviceId || 'unknown');
  const op = spec.op;
  if (!SYNCABLE_OPS.includes(op)) throw new Error(`不支持的 op：${String(op)}；可用：${SYNCABLE_OPS.join('/')}`);
  const eventAt = normalizeTimestamp(at || spec.at) || nowIso();
  const pathValue = typeof spec.path === 'string' && spec.path ? canonicalPath(spec.path) || spec.path : null;
  const rootId = spec.rootId != null ? normalizeRootId(spec.rootId) : null;
  const relPath = spec.relPath != null ? normalizeRelPath(spec.relPath) : null;

  let syncId = typeof spec.syncId === 'string' && spec.syncId ? spec.syncId : null;
  let finalRootId = null;
  let finalRelPath = null;
  let resolvable = false;
  if (rootId && relPath !== null) {
    const base = identityFromRoot(rootId, relPath);
    syncId = base.syncId;
    finalRootId = base.rootId;
    finalRelPath = base.relPath;
    resolvable = true;
  } else if (!syncId && pathValue) {
    const identity = identityForPath(dev, pathValue);
    if (identity) {
      syncId = identity.syncId;
      finalRootId = identity.rootId;
      finalRelPath = identity.relPath;
      resolvable = Boolean(identity.resolvable);
    }
  }
  if (!syncId) throw new Error('makeEvent 需要 syncId / rootId+relPath / path 三者之一来确定条目身份');

  const event = {
    v: SYNC_VERSION,
    op,
    at: eventAt,
    hlc: hlc || normalizeHlcOrNull(spec.hlc) || null,
    device: deviceId,
    syncId,
    rootId: finalRootId,
    relPath: finalRelPath,
    path: pathValue,
    unresolvable: !resolvable,
    by: spec.by ?? null,
    tombstone: op === 'remove',
    data: sanitizeEventData(spec.data),
  };
  event.id = eventFingerprint(event);
  return event;
}

function normalizeHlcOrNull(hlc) {
  return parseHlc(hlc) ? hlc : null;
}

/** 账本条目 → 事件：CLI 在账本发生变化（新增/置顶/改标题/活跃）后调用 */
export function eventFromWorkspace(device, workspace, op, data = {}, opts = {}) {
  const ws = workspace || {};
  const dev = typeof device === 'string' ? { id: device, roots: [] } : device || {};
  let syncId = null;
  let rootId = null;
  let relPath = null;
  if (typeof ws.rootId === 'string' && ws.rootId && typeof ws.relPath === 'string') {
    const base = identityFromRoot(ws.rootId, ws.relPath);
    if (base) {
      syncId = base.syncId;
      rootId = base.rootId;
      relPath = base.relPath;
    }
  }
  if (!syncId && ws.path) {
    const identity = identityForPath(dev, ws.path);
    if (identity) {
      syncId = identity.syncId;
      rootId = identity.rootId;
      relPath = identity.relPath;
    }
  }
  if (!syncId && ws.id) syncId = ws.id;
  return makeEvent(dev, {
    op,
    syncId,
    rootId,
    relPath,
    path: ws.path ?? null,
    by: opts.by ?? null,
    data: {
      displayName: ws.displayName,
      kind: ws.kind,
      pinned: ws.pinned,
      firstSeenAt: ws.firstSeenAt,
      lastActiveAt: ws.lastActiveAt,
      ...data,
    },
  }, opts);
}

/** 账本条目 → 同步身份（baseLedger 播种与事件构造共用同一套推导） */
export function workspaceIdentity(device, workspace) {
  const dev = typeof device === 'string' ? { id: device, roots: [] } : device || {};
  const ws = workspace || {};
  if (typeof ws.rootId === 'string' && ws.rootId && typeof ws.relPath === 'string') {
    const base = identityFromRoot(ws.rootId, ws.relPath);
    if (base) return { ...base, path: fromRelPath(dev, base.rootId, base.relPath) };
  }
  if (typeof ws.path === 'string' && ws.path) {
    return identityForPath(dev, ws.path);
  }
  if (typeof ws.id === 'string' && ws.id) {
    return { syncId: ws.id, syncKey: null, rootId: null, relPath: null, resolvable: false, path: null };
  }
  return null;
}

/**
 * 校验并规范化“从磁盘读出来”的事件。
 * 返回 null = 不是同步事件（跳过）。
 */
export function normalizeIncomingEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const op = raw.op;
  if (!SYNCABLE_OPS.includes(op)) return null;
  const deviceId = typeof raw.device === 'string' && raw.device.trim() ? raw.device.trim() : null;
  if (!deviceId) return null;

  let rootId = raw.rootId != null ? normalizeRootId(raw.rootId) : null;
  let relPath = raw.relPath != null ? normalizeRelPath(raw.relPath) : null;
  let syncId = typeof raw.syncId === 'string' && raw.syncId ? raw.syncId : null;
  let resolvable = Boolean(raw.resolvable);
  if (rootId && relPath !== null) {
    const base = identityFromRoot(rootId, relPath);
    syncId = base.syncId;
    rootId = base.rootId;
    relPath = base.relPath;
    resolvable = true;
  } else {
    rootId = null;
    relPath = null;
    if (!syncId) {
      if (typeof raw.path === 'string' && raw.path) {
        const foreign = foreignIdentity(deviceId, raw.path);
        if (foreign) syncId = foreign.syncId;
      }
    }
    if (!syncId) return null;
    resolvable = false;
  }
  const at = normalizeTimestamp(raw.at);
  const hlc = normalizeHlcOrNull(raw.hlc);
  const event = {
    v: SYNC_VERSION,
    op,
    at: at || null,
    hlc,
    device: deviceId,
    syncId,
    rootId,
    relPath,
    path: typeof raw.path === 'string' && raw.path ? raw.path : null,
    unresolvable: !resolvable,
    by: raw.by ?? null,
    tombstone: raw.tombstone === true || op === 'remove',
    data: sanitizeEventData(raw.data),
  };
  event.id = typeof raw.id === 'string' && raw.id ? raw.id : eventFingerprint(event);
  return event;
}

function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  let invalid = 0;
  for (const raw of Array.isArray(events) ? events : []) {
    const ev = normalizeIncomingEvent(raw);
    if (!ev) {
      invalid += 1;
      continue;
    }
    const fp = eventFingerprint(ev);
    if (seen.has(fp)) {
      duplicates += 1;
      continue;
    }
    seen.add(fp);
    out.push(ev);
  }
  return { events: out, duplicates, invalid };
}

// ---------------------------------------------------------------------------
// 事件日志读写（容错：坏行跳过并计数，不抛）
// ---------------------------------------------------------------------------

/**
 * 读一个 JSONL 事件日志。
 * 返回 { exists, events, badLines, ignored, duplicates, error }。
 * - badLines：JSON 都解析不了的行（半行/被同步工具写坏）
 * - ignored：能解析但不是同步事件的行（历史观测事件、别家格式）
 * - duplicates：同文件内内容重复的事件
 */
export function readEventLog(file) {
  const out = { file, exists: false, events: [], badLines: 0, ignored: 0, duplicates: 0, error: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') out.error = String(err?.message || err);
    return out;
  }
  out.exists = true;
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      out.badLines += 1;
      continue;
    }
    const ev = normalizeIncomingEvent(parsed);
    if (!ev) {
      out.ignored += 1;
      continue;
    }
    const fp = eventFingerprint(ev);
    if (seen.has(fp)) {
      out.duplicates += 1;
      continue;
    }
    seen.add(fp);
    out.events.push(ev);
  }
  return out;
}

export function loadLocalEvents(home) {
  return readEventLog(syncPaths(home).events);
}

/**
 * 追加本地事件（自动领 HLC + at，落盘后返回事件）。
 * 批量写只保存一次时钟状态，避免一事件一次原子写。
 * device 省略时会 loadDevice(home)。
 */
export function appendLocalEvents(home, device, specs = [], opts = {}) {
  const dir = home ? path.resolve(String(home)) : resolveHubHome();
  const dev = device || loadDevice(dir, opts).device;
  const paths = syncPaths(dir);
  ensureDir(dir);
  const clock = loadClock(dir, dev.id);
  const events = [];
  for (const spec of specs) {
    const ev = makeEvent(dev, spec, { hlc: clock.tick(), at: opts.at ?? null });
    appendJsonl(paths.events, ev);
    events.push(ev);
  }
  saveClock(dir, clock);
  return { events, file: paths.events, clock: clock.snapshot() };
}

export function appendLocalEvent(home, device, spec, opts = {}) {
  return appendLocalEvents(home, device, [spec], opts);
}

// ---------------------------------------------------------------------------
// 传输层：共享目录 = devices/<deviceId>/events.jsonl（+ 可选 snapshot）
// ---------------------------------------------------------------------------

/**
 * 读取共享目录里所有设备的事件。
 * 目录不存在 = 首次运行（不是错误）；单个设备目录缺失/不可读只记 error，不影响其它设备。
 */
export function collectEvents(syncDir, opts = {}) {
  const dir = syncDir ? path.resolve(String(syncDir)) : null;
  const result = {
    dir,
    exists: false,
    events: [],
    sources: [],
    devices: {},
    badLines: 0,
    ignored: 0,
    duplicates: 0,
    errors: [],
  };
  if (!dir) throw new Error('collectEvents 需要 syncDir');
  try {
    result.exists = fs.statSync(dir).isDirectory();
  } catch {
    return result; // 目录还没建：正常情况
  }
  if (!result.exists) return result;
  const devicesRoot = path.join(dir, DEVICES_DIR);
  let entries = [];
  try {
    entries = fs.readdirSync(devicesRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') result.errors.push(`devices 目录不可读：${err.message}`);
    return result;
  }
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const deviceId = entry.name;
    const deviceDir = path.join(devicesRoot, deviceId);
    const log = readEventLog(path.join(deviceDir, EVENTS_FILE));
    const metaRead = readJson(path.join(deviceDir, DEVICE_INFO_FILE));
    const source = {
      deviceId,
      dir: deviceDir,
      exists: log.exists,
      events: 0,
      badLines: log.badLines,
      ignored: log.ignored,
      duplicates: log.duplicates,
      error: log.error,
      info: metaRead.ok && metaRead.value && typeof metaRead.value === 'object' ? metaRead.value : null,
    };
    result.badLines += log.badLines;
    result.ignored += log.ignored;
    result.duplicates += log.duplicates;
    if (log.error) result.errors.push(`${deviceId}: ${log.error}`);
    if (source.info) result.devices[deviceId] = source.info;
    for (const ev of log.events) {
      const fp = eventFingerprint(ev);
      if (seen.has(fp)) {
        result.duplicates += 1;
        continue;
      }
      seen.add(fp);
      result.events.push(ev);
      source.events += 1;
    }
    result.sources.push(source);
  }
  return result;
}

/**
 * 把自己的本地事件发布到共享目录。
 * 只追加对方没有的事件（按指纹去重），因此反复调用不会重复。
 */
export function publishEvents(syncDir, device, events = [], opts = {}) {
  const dev = typeof device === 'string' ? { id: device } : device || {};
  const deviceId = String(dev.id || '');
  if (!syncDir) throw new Error('publishEvents 需要 syncDir');
  if (!deviceId) throw new Error('publishEvents 需要 device.id');
  const deviceDir = path.join(path.resolve(String(syncDir)), DEVICES_DIR, deviceId);
  ensureDir(deviceDir);
  if (opts.writeInfo !== false) {
    const infoFile = path.join(deviceDir, DEVICE_INFO_FILE);
    const info = {
      version: SYNC_VERSION,
      id: deviceId,
      name: dev.name ?? deviceId,
      platform: dev.platform ?? process.platform,
      roots: (dev.roots || []).map((r) => ({ id: r.id, path: r.path, priority: r.priority })),
    };
    // 内容没变就不写：这台设备的目录只由自己写，少改文件 = 少给同步工具制造变更
    const prev = readJson(infoFile);
    const same = prev.ok && prev.value && JSON.stringify({ ...prev.value, updatedAt: undefined }) === JSON.stringify({ ...info, updatedAt: undefined });
    if (!same) atomicWriteJson(infoFile, { ...info, updatedAt: nowIso() });
  }
  const logFile = path.join(deviceDir, EVENTS_FILE);
  const existing = readEventLog(logFile);
  const seen = new Set(existing.events.map((ev) => eventFingerprint(ev)));
  const fresh = [];
  let duplicates = 0;
  for (const raw of events) {
    const ev = normalizeIncomingEvent(raw);
    if (!ev) continue;
    const fp = eventFingerprint(ev);
    if (seen.has(fp)) {
      duplicates += 1;
      continue;
    }
    seen.add(fp);
    fresh.push(ev);
  }
  for (const ev of fresh) appendJsonl(logFile, ev);
  return {
    deviceId,
    dir: deviceDir,
    path: logFile,
    appended: fresh.length,
    duplicates,
    total: existing.events.length + fresh.length,
    badLines: existing.badLines,
  };
}

/** 读共享目录里的可选快照（冷启动兜底：本地账本还是空的时候用） */
export function readSnapshot(syncDir) {
  if (!syncDir) return { ok: false, value: null, error: 'no-sync-dir' };
  return readJson(path.join(path.resolve(String(syncDir)), SNAPSHOT_FILE));
}

/** 写快照：合并后的账本（只含跨设备字段 + 解析后的本机路径），加速冷启动 */
export function publishSnapshot(syncDir, ledger, { deviceId = null, now = nowIso() } = {}) {
  if (!syncDir) throw new Error('publishSnapshot 需要 syncDir');
  const file = path.join(path.resolve(String(syncDir)), SNAPSHOT_FILE);
  ensureDir(path.dirname(file));
  const value = {
    version: SYNC_VERSION,
    kind: 'ledger.snapshot',
    generatedAt: now,
    device: deviceId,
    ledger: {
      version: ledger?.version ?? LEDGER_VERSION,
      updatedAt: ledger?.updatedAt ?? now,
      workspaces: Array.isArray(ledger?.workspaces) ? ledger.workspaces : [],
      tombstones: ledger?.tombstones ?? {},
    },
  };
  atomicWriteJson(file, value);
  return { file, workspaces: value.ledger.workspaces.length };
}

// ---------------------------------------------------------------------------
// 合并：baseLedger + events → 合并后的 ledger
// ---------------------------------------------------------------------------

function compareWorkspaces(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const ta = a.lastActiveAt || '';
  const tb = b.lastActiveAt || '';
  if (ta !== tb) return ta < tb ? 1 : -1;
  return String(a.path || a.relPath || a.id).localeCompare(String(b.path || b.relPath || b.id), 'zh-CN');
}

function maxIso(a, b) {
  const na = normalizeTimestamp(a);
  const nb = normalizeTimestamp(b);
  if (!na) return nb;
  if (!nb) return na;
  return na >= nb ? na : nb;
}

function minIso(a, b) {
  const na = normalizeTimestamp(a);
  const nb = normalizeTimestamp(b);
  if (!na) return nb;
  if (!nb) return na;
  return na <= nb ? na : nb;
}

/** kind 合并：project 优先级最高（D2 §6），其它按 LWW（事件已按 HLC 排序） */
function mergeKind(existing, incoming) {
  if (incoming === 'project') return 'project';
  if (existing === 'project') return 'project';
  return incoming || existing || 'project';
}

function emptyItem(syncId, ev) {
  return {
    syncId,
    rootId: null,
    relPath: null,
    originPath: null,
    originDevice: null,
    displayName: null,
    kind: null,
    pinned: false,
    group: null,
    firstSeenAt: null,
    lastActiveAt: null,
    presentIn: [],
    sources: {},
    lastHlc: null,
    eventBacked: false,
    fromBase: false,
    tombstone: null,
  };
}

function cloneItem(item) {
  return {
    ...item,
    presentIn: Array.isArray(item.presentIn) ? [...item.presentIn] : [],
    sources: item.sources && typeof item.sources === 'object' ? { ...item.sources } : {},
    tombstone: item.tombstone ? { ...item.tombstone } : null,
  };
}

/** 内部状态 → 输出账本条目（本机路径解析 + 保留本地事实 presentIn/sources） */
function toWorkspace(device, item) {
  const localPath = item.rootId && item.relPath !== null ? fromRelPath(device, item.rootId, item.relPath) : null;
  const resolvable = Boolean(localPath);
  let workspacePath = resolvable ? localPath : null;
  // 本机产生、但不在任何 root 覆盖范围内的目录：保留本地绝对路径用于展示，
  // 但它没有跨设备身份（resolvable=false），别设备拿不到。
  if (!resolvable && item.originDevice && item.originDevice === device.id && item.originPath) {
    workspacePath = item.originPath;
  }
  const displayName =
    item.displayName ||
    (item.relPath ? path.posix.basename(item.relPath) : null) ||
    (workspacePath ? defaultTitle(workspacePath) : null) ||
    item.syncId;
  // presentIn/sources 是“本机工具里有没有它”的本地事实：只有本机条目才保留，
  // 远端新增的条目留空，等本机下一次 scan 再填（DESIGN §10 设备差异）。
  const isLocalEntry = resolvable || (item.originDevice && item.originDevice === device.id);
  const keySource = resolvable ? localPath : isLocalEntry ? item.originPath : null;
  return {
    id: item.syncId,
    // 无法还原到本机的远端条目没有本地路径，但 key 也不能是 null：
    // ledger.mjs 用 key 建 Map，多个 null 会互相覆盖。给一个唯一合成 key（不会被本机 scan 命中）。
    key: keySource ? pathKey(keySource) : `unresolvable:${item.syncId}`,
    path: workspacePath,
    displayName,
    kind: item.kind || 'project',
    pinned: Boolean(item.pinned),
    group: item.group ?? null,
    firstSeenAt: item.firstSeenAt || null,
    lastActiveAt: item.lastActiveAt || null,
    presentIn: isLocalEntry && Array.isArray(item.presentIn) ? [...item.presentIn] : [],
    sources: isLocalEntry && item.sources && typeof item.sources === 'object' ? { ...item.sources } : {},
    rootId: item.rootId ?? null,
    relPath: item.relPath ?? null,
    resolvable,
    originDevice: item.originDevice ?? null,
    originPath: item.originPath ?? null,
    lastHlc: item.lastHlc ?? null,
  };
}

function sameWorkspace(a, b) {
  if (!a || !b) return false;
  return (
    a.displayName === b.displayName &&
    Boolean(a.pinned) === Boolean(b.pinned) &&
    (a.kind || 'project') === (b.kind || 'project') &&
    a.lastActiveAt === b.lastActiveAt &&
    a.firstSeenAt === b.firstSeenAt &&
    Boolean(a.resolvable) === Boolean(b.resolvable) &&
    a.path === b.path
  );
}

/**
 * 纯函数合并：baseLedger + events → 合并后的账本。
 *
 * 规则：
 *   - baseLedger 里的本地条目先入 state（保证「本地已有目录不因为云端没事件就消失」，
 *     也支持首次同步前账本里已有一堆扫描结果）；
 *   - 事件按 HLC 升序重放，per-item LWW；
 *   - add 可以让条目存在；remove 记 tombstone 并从 workspaces 移除；
 *   - tombstone 之后再来旧的 add/touch/pin/title/kind 一律忽略（删除不复活）；
 *     只有 HLC 严格更新的 add 才会显式复活（用户重新加回目录）；
 *   - 默认只加不减：没有任何事件提到的 base 条目原样保留，绝不因为“对端没有”而删除；
 *   - 幂等：同样输入重复合并结果不变（重复事件按指纹去重）。
 *
 * 返回 { ledger, changes, stats }：
 *   ledger = { version, updatedAt, workspaces, tombstones }
 *   changes = { added, updated, removed, unresolved }（removed 是 base 里被删除的条目）
 *   stats = 计数，便于 CLI/日志对账
 */
export function mergeEvents(baseLedger = emptyLedger(), events = [], device = {}, opts = {}) {
  const dev = typeof device === 'string' ? { id: device, roots: [] } : device || {};
  const selfId = String(dev.id || 'unknown');
  const now = normalizeTimestamp(opts.now) || nowIso();
  const base = baseLedger && Array.isArray(baseLedger.workspaces) ? baseLedger : emptyLedger();
  const stats = {
    base: 0,
    events: Array.isArray(events) ? events.length : 0,
    validEvents: 0,
    invalidEvents: 0,
    duplicateEvents: 0,
    staleIgnored: 0,
    resurrected: 0,
    tombstoned: 0,
    unresolved: 0,
  };

  const items = new Map();
  const tombstones = new Map();

  // 1) base 播种：本地账本/上次合并结果都是“已经存在的事实”
  for (const ws of base.workspaces) {
    if (!ws || typeof ws !== 'object') continue;
    const identity = workspaceIdentity(dev, ws);
    if (!identity) continue;
    const item = emptyItem(identity.syncId, null);
    item.rootId = identity.rootId ?? (typeof ws.rootId === 'string' && ws.rootId ? normalizeRootId(ws.rootId) : null);
    item.relPath = identity.relPath ?? (typeof ws.relPath === 'string' ? normalizeRelPath(ws.relPath) : null);
    item.originPath = typeof ws.path === 'string' ? ws.path : identity.path ?? null;
    item.originDevice = typeof ws.originDevice === 'string' && ws.originDevice ? ws.originDevice : selfId;
    item.displayName = typeof ws.displayName === 'string' && ws.displayName ? ws.displayName : null;
    item.kind = ws.kind || null;
    item.pinned = Boolean(ws.pinned);
    item.group = ws.group ?? null;
    item.firstSeenAt = normalizeTimestamp(ws.firstSeenAt);
    item.lastActiveAt = normalizeTimestamp(ws.lastActiveAt);
    item.presentIn = Array.isArray(ws.presentIn) ? [...ws.presentIn] : [];
    item.sources = ws.sources && typeof ws.sources === 'object' ? { ...ws.sources } : {};
    item.lastHlc = parseHlc(ws.lastHlc) ? ws.lastHlc : null;
    item.eventBacked = Boolean(item.lastHlc);
    item.fromBase = true;
    items.set(identity.syncId, item);
    stats.base += 1;
  }
  // base 里的旧 tombstone 记录要带下去（否则下次合并旧 add 又可能复活）
  for (const [syncId, record] of Object.entries(base.tombstones || {})) {
    if (!record || typeof record !== 'object' || !parseHlc(record.hlc)) continue;
    const prev = tombstones.get(syncId);
    if (!prev || compareHlc(record.hlc, prev.hlc) > 0) tombstones.set(syncId, { ...record });
  }
  // tombstone 也要进 state：如果只拿到旧 add 事件（对端还没补齐 remove），
  // 在空 state 上会“新建”条目让删除复活。先立一个墓碑占位，旧 add 就会被判 stale。
  for (const [syncId, record] of tombstones) {
    if (items.has(syncId)) continue;
    const placeholder = emptyItem(syncId, null);
    placeholder.rootId = normalizeRootId(record.rootId) || null;
    placeholder.relPath = typeof record.relPath === 'string' ? normalizeRelPath(record.relPath) : null;
    placeholder.originPath = typeof record.path === 'string' ? record.path : null;
    placeholder.eventBacked = true;
    placeholder.tombstone = { hlc: record.hlc, device: record.device ?? null, at: record.at ?? null };
    items.set(syncId, placeholder);
  }
  // 应用事件前的快照（diff 用）：跟最终结果同形状，避免字段口径打架。
  // 已删除的占位条目不进快照，否则会被误记成“本次新增的删除”。
  const baseView = new Map();
  for (const [syncId, item] of items) {
    if (item.tombstone) continue;
    baseView.set(syncId, toWorkspace(dev, cloneItem(item)));
  }

  // 2) 事件清洗 + 排序（HLC 升序 = 因果顺序；同 HLC 用 deviceId 决平局已在 HLC 尾部）
  const cleaned = dedupeEvents(events);
  stats.invalidEvents = cleaned.invalid;
  stats.duplicateEvents = cleaned.duplicates;
  const ordered = cleaned.events.slice().sort((a, b) => compareHlc(eventOrderKey(a), eventOrderKey(b)));
  stats.validEvents = ordered.length;

  // 3) 重放事件
  for (const ev of ordered) {
    const key = eventOrderKey(ev);
    let item = items.get(ev.syncId);
    if (!item) {
      item = emptyItem(ev.syncId, ev);
      items.set(ev.syncId, item);
    }
    if (!item.rootId && ev.rootId) {
      item.rootId = ev.rootId;
      item.relPath = ev.relPath;
    }
    if (!item.originPath && ev.path) item.originPath = ev.path;
    if (!item.originDevice && ev.device) item.originDevice = ev.device;
    item.lastHlc = maxHlc(item.lastHlc, key);
    item.eventBacked = true;

    const existingTombstone = item.tombstone;
    const staleAgainstTombstone = existingTombstone && compareHlc(key, existingTombstone.hlc) <= 0;
    if (staleAgainstTombstone && ev.op !== 'add') {
      // 删除之后重放旧事件：不改字段、更不复活
      stats.staleIgnored += 1;
      continue;
    }

    switch (ev.op) {
      case 'add': {
        if (staleAgainstTombstone) {
          stats.staleIgnored += 1;
          continue;
        }
        if (item.tombstone) {
          item.tombstone = null;
          stats.resurrected += 1;
        }
        const data = ev.data || {};
        if (!item.displayName && typeof data.displayName === 'string' && data.displayName) item.displayName = data.displayName;
        if (!item.kind && typeof data.kind === 'string' && data.kind) item.kind = data.kind;
        item.firstSeenAt = minIso(item.firstSeenAt, normalizeTimestamp(data.firstSeenAt) || ev.at);
        item.lastActiveAt = maxIso(item.lastActiveAt, normalizeTimestamp(data.lastActiveAt));
        break;
      }
      case 'touch':
        item.lastActiveAt = maxIso(item.lastActiveAt, normalizeTimestamp(ev.data?.lastActiveAt) || ev.at);
        break;
      case 'pin':
        item.pinned = typeof ev.data?.pinned === 'boolean' ? ev.data.pinned : true;
        break;
      case 'title': {
        const title = ev.data?.displayName ?? ev.data?.title;
        if (typeof title === 'string' && title.trim()) item.displayName = title.trim();
        break;
      }
      case 'kind':
        item.kind = mergeKind(item.kind, ev.data?.kind);
        break;
      case 'remove':
        if (!item.tombstone || compareHlc(key, item.tombstone.hlc) > 0) {
          item.tombstone = {
            hlc: key,
            device: ev.device,
            at: ev.at,
            rootId: item.rootId,
            relPath: item.relPath,
            path: item.originPath,
          };
        }
        tombstones.set(ev.syncId, { ...item.tombstone });
        break;
      default:
        break;
    }
  }

  // 4) 输出：tombstone 的条目从 workspaces 移除，tombstones 表保留
  const live = [];
  const liveIds = new Set();
  const unresolved = [];
  // 未映射的远端 root 分布：rootId → 条数（null 记作 "(no-root)"）。
  // CLI 用它给用户提示「加一条 alias 就能让这批条目变成本机可打开」。
  const unmappedRoots = {};
  for (const item of items.values()) {
    if (item.tombstone) {
      stats.tombstoned += 1;
      if (!tombstones.has(item.syncId)) {
        tombstones.set(item.syncId, {
          hlc: item.tombstone.hlc,
          device: item.tombstone.device,
          at: item.tombstone.at,
          rootId: item.rootId,
          relPath: item.relPath,
          path: item.originPath,
        });
      }
      continue;
    }
    const ws = toWorkspace(dev, item);
    live.push(ws);
    liveIds.add(ws.id);
    if (!ws.resolvable) {
      unresolved.push(ws);
      const bucket = ws.rootId || '(no-root)';
      unmappedRoots[bucket] = (unmappedRoots[bucket] || 0) + 1;
    }
  }
  live.sort(compareWorkspaces);
  stats.unmappedRoots = unmappedRoots;

  // 5) diff：跟“应用事件前”的快照比较
  const changes = { added: [], updated: [], removed: [], unresolved };
  for (const ws of live) {
    const before = baseView.get(ws.id);
    if (!before) {
      changes.added.push(ws);
      continue;
    }
    if (!sameWorkspace(ws, before)) changes.updated.push(ws);
  }
  for (const [syncId, before] of baseView) {
    if (liveIds.has(syncId)) continue;
    changes.removed.push(before);
  }

  return {
    ledger: {
      version: LEDGER_VERSION,
      updatedAt: now,
      workspaces: live,
      tombstones: Object.fromEntries([...tombstones.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
    changes,
    stats,
  };
}

// ---------------------------------------------------------------------------
// 一站式 sync：collect → merge → publish → 返回 diff
// ---------------------------------------------------------------------------

/**
 * 一次完整同步（单机视角）：
 *   1. 读本地账本（baseLedger，没传就 load <home>/ledger.json；本地空时用共享目录快照兜底）
 *   2. collect 共享目录里所有设备的事件
 *   3. 合并成本机视角的账本（远端 relPath 已还原成本机路径）
 *   4. publish 自己的本地事件（只增不重）
 *   5. HLC 取 max 后落盘
 * 不写 ledger.json：返回 merged ledger，由 CLI 决定是否保存。
 *
 * @param {string} syncDir 共享目录（iCloud/Syncthing/Git 工作副本都行）
 * @param {{home?:string, device?:object, baseLedger?:object, snapshot?:boolean, dryRun?:boolean, now?:string}} opts
 */
export function sync(syncDir, opts = {}) {
  if (!syncDir) throw new Error('sync(dir, opts) 需要一个共享同步目录');
  const dir = path.resolve(String(syncDir));
  const home = opts.home ? path.resolve(String(opts.home)) : resolveHubHome();
  const device = opts.device || loadDevice(home).device;
  const now = normalizeTimestamp(opts.now) || nowIso();

  const localLog = readEventLog(syncPaths(home).events);
  const collected = collectEvents(dir);

  // 本地事件优先（保持本机写入顺序），远端再并进来；跨来源重复由指纹消掉
  const combined = [...localLog.events, ...collected.events];
  const deduped = dedupeEvents(combined);

  // HLC 取 max：把见过的所有远端 HLC 纳入本地时钟，之后本地新事件一定更大
  const clock = loadClock(home, device.id);
  for (const ev of deduped.events) clock.observe(eventOrderKey(ev));

  // base 选择：显式 > 本地账本（非空）> 共享目录快照 > 空账本
  let base = opts.baseLedger || null;
  let baseSource = opts.baseLedger ? 'explicit' : null;
  if (!base) {
    const loaded = loadLedger(home);
    if (loaded.ledger && loaded.ledger.workspaces.length) {
      base = loaded.ledger;
      baseSource = 'local';
    }
  }
  if (!base) {
    const snap = readSnapshot(dir);
    if (snap.ok && snap.value && snap.value.ledger && Array.isArray(snap.value.ledger.workspaces)) {
      base = snap.value.ledger;
      baseSource = 'snapshot';
    }
  }
  if (!base) {
    base = emptyLedger();
    baseSource = 'empty';
  }

  const merged = mergeEvents(base, deduped.events, device, { now });

  let published = null;
  let snapshot = null;
  if (!opts.dryRun) {
    published = publishEvents(dir, device, localLog.events);
    saveClock(home, clock);
    if (opts.snapshot) {
      snapshot = publishSnapshot(dir, merged.ledger, { deviceId: device.id, now });
    }
  }

  return {
    device,
    syncDir: dir,
    home,
    baseSource,
    ledger: merged.ledger,
    merged: merged.ledger,
    changes: merged.changes,
    stats: {
      ...merged.stats,
      collectedEvents: collected.events.length,
      localEvents: localLog.events.length,
      combinedEvents: combined.length,
      duplicateEvents: merged.stats.duplicateEvents + deduped.duplicates,
      badLines: localLog.badLines + collected.badLines,
      ignoredLines: localLog.ignored + collected.ignored,
      devices: collected.sources.length,
    },
    collect: collected,
    localLog: { file: localLog.file, events: localLog.events.length, badLines: localLog.badLines, ignored: localLog.ignored },
    published,
    snapshot,
    clock: clock.snapshot(),
  };
}

// ---------------------------------------------------------------------------
// 首次迁移：把本机现有账本播种成事件（让对端第一次就能看到已有项目）
// ---------------------------------------------------------------------------

/**
 * 把本机账本里「还没同步过」的条目转成 add 事件并写入本地事件日志。
 * 首次接入同步目录时跑一次，对端 collect + merge 后就能看到这些目录；
 * 已同步过的条目（ws.lastHlc 存在）跳过，重复调用幂等。
 */
export function bootstrapLocalEvents(home, device, ledger, opts = {}) {
  const dir = home ? path.resolve(String(home)) : resolveHubHome();
  const dev = device || loadDevice(dir).device;
  const paths = syncPaths(dir);
  ensureDir(dir);
  const clock = loadClock(dir, dev.id);
  const existing = readEventLog(paths.events);
  const alignedIds = new Set(
    existing.events.filter((ev) => ev.op === 'add' && ev.hlc).map((ev) => ev.syncId)
  );
  const emitted = [];
  let skipped = 0;
  for (const ws of ledger?.workspaces || []) {
    if (!ws || typeof ws !== 'object') continue;
    if (ws.lastHlc) {
      skipped += 1;
      continue;
    }
    const identity = workspaceIdentity(dev, ws);
    if (!identity) {
      skipped += 1;
      continue;
    }
    if (alignedIds.has(identity.syncId)) {
      skipped += 1;
      continue;
    }
    const ev = makeEvent(dev, {
      op: 'add',
      syncId: identity.syncId,
      rootId: identity.rootId,
      relPath: identity.relPath,
      path: ws.path ?? identity.path ?? null,
      by: opts.by || 'bootstrap',
      data: {
        displayName: ws.displayName,
        kind: ws.kind,
        pinned: ws.pinned,
        firstSeenAt: ws.firstSeenAt,
        lastActiveAt: ws.lastActiveAt,
      },
    }, { hlc: clock.tick(), at: opts.at ?? null });
    appendJsonl(paths.events, ev);
    alignedIds.add(identity.syncId);
    emitted.push(ev);
  }
  if (emitted.length) saveClock(dir, clock);
  // events 与 emitted 是同一个数组（emitted 是给 CLI 打印用的别名）
  return { events: emitted, emitted, skipped, file: paths.events, clock: clock.snapshot() };
}
