/**
 * 设备身份与跨设备 root 映射 —— v1.0 云端同步的地基。
 *
 * 为什么需要（docs/DESIGN.md §5）：
 *   绝对路径在设备之间不可比：Mac 上是 /Users/a/claude/x，Windows 上是 C:\Users\b\claude\x，
 *   但它们其实是同一个项目。真正可比的只有「相对某个 root 的位置」（relPath）。
 *   所以跨设备只传 (rootId, relPath)，每台设备再用自己的 roots 还原成本机绝对路径。
 *
 * rootId 是跨设备的“语义名字”（claude / desktop / documents / home ...），
 * 两台设备给同一类目录起同一个 rootId，relPath 才拼得起来。path 只属于本机。
 *
 * 设备身份：<home>/device.json（默认 ~/.workspace-hub/device.json；WSHUB_HOME / WDHUB_HOME 可覆盖）。
 *   同一台设备的 id 永远不能变——它变了，对端会以为是两台新设备，事件日志会分叉。
 *   因此 device.json 损坏时**不自动重建**（fail-closed），宁可直接报错让用户修。
 *
 * 路径归一化、大小写、Unicode 等统一复用 hub/lib/paths.mjs，避免两套规则打架。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalPath, stableId } from './paths.mjs';
import { isAbsoluteAnyPlatform, pathModuleFor } from './platform.mjs';
import { readJson, atomicWriteJson, ensureDir, nowIso } from './safety.mjs';

export const DEVICE_VERSION = 1;
export const DEVICE_FILE = 'device.json';

/** 账本目录环境变量：新名字优先，兼容旧 CLI 的 WDHUB_HOME */
export const HOME_ENV_VARS = ['WSHUB_HOME', 'WDHUB_HOME'];

/** 这些平台上文件名大小写不敏感，匹配 root 时要折大小写 */
const CASE_INSENSITIVE_PLATFORMS = new Set(['darwin', 'win32']);

/** Windows 绝对路径（盘符 / UNC / 长路径前缀） */
const WINDOWS_ABS = /^(?:[A-Za-z]:[\\/]|\\\\[?.]\\)/;

function looksWindowsAbsolute(p) {
  return typeof p === 'string' && WINDOWS_ABS.test(p.trim());
}

/**
 * 纯字符串归一 Windows 绝对路径（不做 realpath / 不碰文件系统）。
 * 用途：在非 Windows 机器上加载/模拟 win32 设备的 roots（测试、或把另一台机器的
 * device.json 拷过来看一眼）时，不能让本机 canonicalPath 把 `C:\Users\b\tmp`
 * 当成相对路径拼到当前 home 下面。
 */
function normalizeWindowsPathString(p) {
  const raw = p.trim().normalize('NFC');
  const unc = raw.startsWith('\\\\');
  let out = raw.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  if (unc) out = '\\' + out; // 还原 UNC 的前导双反斜杠
  if (out.length > 3) out = out.replace(/\\+$/, ''); // 去尾分隔符（保留 C:\ 根）
  return out;
}

/**
 * 按“设备平台”规范路径：
 *   - 本机就是该平台（正常情况）→ 走 paths.mjs 的 canonicalPath（realpath/NFC/去尾斜杠）
 *   - 本机不是该平台，但输入是 Windows 绝对路径（测试/跨平台读取）→ 纯字符串归一
 * 这样 `platform:'win32'` 的设备对象在 macOS 上也能被正确匹配与还原，测试无需真 Windows。
 */
function canonicalPathFor(input, platform = process.platform) {
  const raw = typeof input === 'string' ? input.trim() : input;
  if (!raw) return canonicalPath(input);
  if (platform === 'win32' && process.platform !== 'win32' && looksWindowsAbsolute(raw)) {
    return normalizeWindowsPathString(raw);
  }
  return canonicalPath(input);
}

/** root 路径的分隔符：反斜杠（含盘符/UNC）用 `\`，否则用本机 path.sep */
function separatorStyle(p) {
  return typeof p === 'string' && (p.includes('\\') || /^[A-Za-z]:/.test(p)) ? '\\' : path.sep;
}

/** 解析账本/设备目录：显式参数 > WSHUB_HOME / WDHUB_HOME > ~/.workspace-hub（与 CLI 默认一致） */
export function resolveHubHome({ home, env = process.env, homedir = os.homedir() } = {}) {
  if (home) return path.resolve(String(home));
  for (const key of HOME_ENV_VARS) {
    const v = env?.[key];
    if (v) return path.resolve(v);
  }
  return path.join(homedir, '.workspace-hub');
}

export function defaultDeviceName() {
  try {
    return os.hostname() || 'unknown-device';
  } catch {
    return 'unknown-device';
  }
}

/**
 * 本机默认 roots。id 是跨设备契约，path 只是本机位置。
 * 优先级只影响「同长度前缀」这种几乎不发生的平局；实际匹配永远最长前缀优先，
 * 所以 ~/claude 会比兜底的 ~ 更具体。
 */
export function defaultRoots({ homedir = os.homedir(), platform = process.platform } = {}) {
  const home = canonicalPathFor(homedir, platform) || homedir;
  const join = pathModuleFor(platform).join;
  const specs = [
    ['claude', 'claude 主代码目录', 100, 'claude'],
    ['code', 'code 代码目录', 90, 'code'],
    ['desktop', '桌面', 80, 'Desktop'],
    ['documents', '文稿', 70, 'Documents'],
    ['downloads', '下载', 60, 'Downloads'],
    ['home', '用户目录（兜底 root）', 10, ''],
  ];
  const roots = specs.map(([id, label, priority, seg]) => ({
    id,
    label,
    priority,
    path: seg ? join(home, seg) : home,
  }));
  return normalizeRoots(roots, { platform });
}

/** rootId 归一化：小写、Unicode NFC、空白/斜杠折成 -。跨设备比较全靠它 */
export function normalizeRootId(input) {
  if (input == null) return null;
  let id = String(input).trim().toLowerCase().normalize('NFC');
  if (!id) return null;
  id = id.replace(/[\\/\s]+/g, '-').replace(/^[.:-]+/, '').replace(/[.:-]+$/, '');
  return id || null;
}

/**
 * relPath 归一化：统一用 /、Unicode NFC、去掉 ./ 与空段。
 * 拒绝 `..`（不能靠 relPath 跳出 root）。空字符串合法（= root 本身）。
 */
export function normalizeRelPath(input) {
  if (typeof input !== 'string') return null;
  const raw = input.replace(/\\/g, '/').normalize('NFC');
  const parts = raw.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (parts.some((seg) => seg === '..')) return null;
  return parts.join('/');
}

/**
 * 尽量规范化路径：完整 realpath 失败（路径还不存在）时，
 * 把「已存在的最长祖先」realpath 后拼回剩余段。
 * 为什么需要：root 可能指向还没建的目录；若存了 /tmp/x 而将来真实路径是 /private/tmp/x，
 * 之后所有项目都会被判成 no-root-match。这里先把能确定的部分解析掉。
 */
function canonicalizeBestEffort(input, platform = process.platform) {
  const canon = canonicalPathFor(input, platform);
  if (!canon) return null;
  // 非本机平台的 Windows 路径：本机 realpath 没有意义，纯字符串归一已经足够
  if (platform === 'win32' && process.platform !== 'win32' && looksWindowsAbsolute(canon)) return canon;
  try {
    fs.lstatSync(canon);
    return canon;
  } catch {
    // 不存在：逐级往上找可解析的祖先
  }
  let cur = canon;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) return canon;
    tail.unshift(path.basename(cur));
    cur = parent;
    try {
      const real = fs.realpathSync.native(cur);
      return path.normalize(path.join(real, ...tail));
    } catch {
      // 继续往上
    }
  }
  return canon;
}

/** 从字符串或对象构造一个规范 root；路径不存在也保留（以后可能创建） */
export function normalizeRoot(raw, { platform = process.platform } = {}) {
  if (!raw) return null;
  const input = typeof raw === 'string' ? { path: raw } : raw;
  const abs = canonicalizeBestEffort(input.path, platform);
  if (!abs) return null;
  const derivedId = normalizeRootId(path.basename(abs)) || 'root';
  const id = normalizeRootId(input.id) || derivedId;
  const label = String(input.label || input.id || derivedId);
  const num = Number(input.priority);
  const priority = Number.isFinite(num) ? num : 50;
  return { id, label, path: abs, priority };
}

/**
 * 归一化 roots 列表：去重（同 id / 同路径保留高优先级）、按优先级与具体程度排序。
 * 排序 = 展示顺序，也是“同长度前缀”时的平局裁决。
 */
export function normalizeRoots(roots, { platform = process.platform } = {}) {
  const list = (Array.isArray(roots) ? roots : [])
    .map((r) => normalizeRoot(r, { platform }))
    .filter(Boolean)
    .sort((a, b) => (b.priority - a.priority) || (b.path.length - a.path.length) || a.id.localeCompare(b.id));
  const byPath = new Map();
  const byId = new Map();
  const out = [];
  for (const root of list) {
    const pathKeyOnly = platform === 'darwin' || platform === 'win32' ? root.path.toLowerCase() : root.path;
    const idKey = root.id;
    const existingById = byId.get(idKey);
    const existingByPath = byPath.get(pathKeyOnly);
    // 同一个 id 只允许一个路径；同一路径只保留优先级最高的那个 id
    if (existingById || existingByPath) continue;
    byId.set(idKey, root);
    byPath.set(pathKeyOnly, root);
    out.push(root);
  }
  return out;
}

/** 纯函数：构造设备对象（测试和首次运行都用它） */
export function createDevice({
  id,
  name = defaultDeviceName(),
  platform = process.platform,
  roots = defaultRoots({ platform }),
  now = nowIso(),
} = {}) {
  return {
    version: DEVICE_VERSION,
    id: typeof id === 'string' && id.trim() ? id.trim() : crypto.randomUUID(),
    name: String(name || defaultDeviceName()),
    platform,
    createdAt: now,
    updatedAt: now,
    roots: normalizeRoots(roots, { platform }),
    rootAliases: {},
  };
}

/**
 * root 别名表：{ <远端/历史 rootId>: <本机已有 rootId> }。
 * 用途：不同机器对同一个目录换了根名（如 Windows 的 `1new-code` 与 Mac 的 `code`），
 * 接收端可以把远端 rootId 解析到本机已有的根上，条目就能还原成本机路径。
 * 规则：只保留两端都合法的 id；不保留指向自己的别名；键规范化并排序，保证输出稳定。
 */
export function normalizeRootAliases(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [from, to] of Object.entries(raw)) {
    const f = normalizeRootId(from);
    const t = normalizeRootId(to);
    if (!f || !t || f === t) continue;
    out[f] = t;
  }
  const sorted = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key];
  return sorted;
}

/** 设置一条 root 别名（原地改 device）；返回同一个 device */
export function setRootAlias(device, from, to) {
  const f = normalizeRootId(from);
  const t = normalizeRootId(to);
  if (!f || !t) throw new Error(`别名非法：${from}=${to}（两边都要是非空 rootId）`);
  if (f === t) throw new Error(`别名两端相同：${f}`);
  device.rootAliases = normalizeRootAliases({ ...(device.rootAliases || {}), [f]: t });
  return device;
}

/** 删除一条 root 别名（原地改 device）；没命中返回 null */
export function removeRootAlias(device, from) {
  const f = normalizeRootId(from);
  const before = normalizeRootAliases(device.rootAliases);
  if (!f || !before[f]) return null;
  delete before[f];
  device.rootAliases = before;
  return device;
}

/** 解析 rootId：本机有同名根就用它，否则看别名表能否落到本机已有的根 */
export function resolveLocalRootId(device, rootId) {
  const id = normalizeRootId(rootId);
  if (!id) return null;
  const roots = device?.roots || [];
  if (roots.some((r) => r.id === id)) return id;
  const alias = normalizeRootAliases(device?.rootAliases)[id];
  if (alias && roots.some((r) => r.id === alias)) return alias;
  return null;
}

/** 把磁盘上的对象修成合法设备；repaired 表示需要回写（缺字段/roots 需要归一化） */
export function normalizeDevice(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('device.json 形状非法（应为对象）');
  }
  let repaired = false;
  let id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    // 有文件但没有 id：这是异常状态，补一个并标记 repaired（宁可告警也不静默换身份）
    id = crypto.randomUUID();
    repaired = true;
  }
  const platform = raw.platform || opts.platform || process.platform;
  const rootsRaw = Array.isArray(raw.roots) && raw.roots.length
    ? raw.roots
    : defaultRoots({ platform, homedir: opts.homedir });
  const roots = normalizeRoots(rootsRaw, { platform });
  const prevRoots = Array.isArray(raw.roots) ? raw.roots : null;
  if (!prevRoots || JSON.stringify(prevRoots) !== JSON.stringify(roots)) repaired = true;
  const rootAliases = normalizeRootAliases(raw.rootAliases);
  if (JSON.stringify(normalizeRootAliases(raw.rootAliases)) !== JSON.stringify(raw.rootAliases || {})) {
    // 别名表被规范化过（有非法/顺序变化）也要回写，避免每次读都重复修
    if (JSON.stringify(raw.rootAliases || {}) !== '{}') repaired = true;
  }
  if (raw.version !== DEVICE_VERSION) repaired = true;
  const device = {
    version: DEVICE_VERSION,
    id,
    name: String(raw.name || opts.name || defaultDeviceName()),
    platform,
    createdAt: raw.createdAt || opts.now || nowIso(),
    updatedAt: raw.updatedAt || opts.now || nowIso(),
    roots,
    rootAliases,
  };
  return { device, repaired };
}

/**
 * 读取（或首次生成）设备身份。
 * 返回 { device, created, repaired, path, home }。
 * device.json 存在但坏掉时抛错：不允许悄悄换设备 id。
 */
export function loadDevice(home, opts = {}) {
  const dir = home ? path.resolve(String(home)) : resolveHubHome(opts);
  const file = path.join(dir, DEVICE_FILE);
  const read = readJson(file);
  if (read.ok) {
    if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value)) {
      throw new Error(`device.json 内容非法（${file}）；为避免设备身份漂移，不会自动重建，请手工修复或删除后重来。`);
    }
    const { device, repaired } = normalizeDevice(read.value, { ...opts, homedir: opts.homedir });
    if (repaired) saveDevice(dir, device);
    return { device, created: false, repaired, path: file, home: dir };
  }
  if (read.error !== 'not-found') {
    throw new Error(`device.json 读取/解析失败（${file}）：${read.error}。为避免设备身份漂移，不会自动重建。`);
  }
  const device = createDevice(opts);
  saveDevice(dir, device);
  return { device, created: true, repaired: false, path: file, home: dir };
}

/** 写回设备身份（原子写） */
export function saveDevice(home, device) {
  const dir = home ? path.resolve(String(home)) : resolveHubHome();
  ensureDir(dir);
  const file = path.join(dir, DEVICE_FILE);
  const value = {
    version: DEVICE_VERSION,
    id: device.id,
    name: device.name,
    platform: device.platform || process.platform,
    createdAt: device.createdAt || nowIso(),
    updatedAt: nowIso(),
    roots: normalizeRoots(device.roots || [], { platform: device.platform || process.platform }),
  };
  const aliases = normalizeRootAliases(device.rootAliases);
  if (Object.keys(aliases).length) value.rootAliases = aliases;
  atomicWriteJson(file, value);
  return value;
}

/**
 * 原地修改 device.roots（同时返回该 device）。
 * 为什么原地改：CLI 的调用习惯是 `addRoot(device, path); saveDevice(home, device)`，
 * 不依赖返回值；原地修改让两种写法都成立（返回新对象会让不接返回值的调用静默丢改动）。
 */
export function setRoots(device, roots) {
  device.roots = normalizeRoots(roots, { platform: device.platform || process.platform });
  return device;
}

/** 加一个 root（字符串或 {id,path,priority}）；返回同一个 device */
export function addRoot(device, root) {
  const normalized = normalizeRoot(root, { platform: device.platform || process.platform });
  if (!normalized) throw new Error(`root 非法：${JSON.stringify(root)}`);
  const rest = (device.roots || []).filter((r) => r.id !== normalized.id && r.path !== normalized.path);
  return setRoots(device, [...rest, normalized]);
}

/** 删一个 root（按 id 或路径）；删除成功返回同一 device，没命中返回 null */
export function removeRoot(device, idOrPath) {
  const key = String(idOrPath || '');
  const target = normalizeRootId(key);
  const before = device.roots || [];
  const roots = before.filter((r) => r.id !== target && r.path !== key);
  if (roots.length === before.length) return null;
  setRoots(device, roots);
  return device;
}

/** 本机是否配置了该 rootId（判断 relPath 能否还原的前提） */
export function hasRoot(device, rootId) {
  const id = normalizeRootId(rootId);
  if (!id) return false;
  return (device?.roots || []).some((r) => r.id === id);
}

/**
 * 最长前缀匹配：绝对路径 → 命中的 root + relPath。
 * 返回 { root, relPath, absPath } 或 null。
 * 大小写按设备平台处理：macOS/Windows 文件系统不敏感，比较时折小写；relPath 仍保留原大小写。
 */
export function matchRoot(device, absPath) {
  const platform = device?.platform || process.platform;
  const canon = canonicalPathFor(absPath, platform);
  if (!canon) return null;
  const ci = CASE_INSENSITIVE_PLATFORMS.has(platform);
  const fold = (s) => (ci ? s.toLowerCase() : s);
  const folded = fold(canon);
  let best = null;
  for (const root of device?.roots || []) {
    if (!root || !root.path) continue;
    const rootPath = root.path;
    // 分隔符跟随 root 的写法：win32 root（C:\ 或 UNC）用 `\`，POSIX root 用本机 path.sep
    const sep = separatorStyle(rootPath);
    const rootWithSep = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
    const same = folded === fold(rootPath);
    const under = !same && folded.startsWith(fold(rootWithSep));
    if (!same && !under) continue;
    const candidate = { root, relPath: same ? '' : canon.slice(rootWithSep.length), absPath: canon };
    if (!best) {
      best = candidate;
      continue;
    }
    // 最长前缀优先；长度相同（几乎不会）再看 priority
    if (rootPath.length > best.root.path.length) best = candidate;
    else if (rootPath.length === best.root.path.length && (root.priority || 0) > (best.root.priority || 0)) best = candidate;
  }
  return best;
}

/**
 * 绝对路径 → relPath（**跨设备发布格式：永远用 `/` 分隔**）。
 * 无法匹配任何 root 时返回 resolvable:false（这类条目只能在本机展示，不播种到别的设备）。
 */
export function toRelPath(device, absPath) {
  const platform = device?.platform || process.platform;
  const canon = canonicalPathFor(absPath, platform);
  if (!canon) return { resolvable: false, reason: 'invalid-path', rootId: null, relPath: null, absPath: null, root: null };
  const matched = matchRoot(device, canon);
  if (!matched) {
    return { resolvable: false, reason: 'no-root-match', rootId: null, relPath: null, absPath: canon, root: null };
  }
  const relPath = normalizeRelPath(matched.relPath);
  if (relPath === null) {
    return { resolvable: false, reason: 'invalid-rel-path', rootId: null, relPath: null, absPath: canon, root: null };
  }
  return { resolvable: true, reason: null, rootId: matched.root.id, relPath, absPath: canon, root: matched.root };
}

/**
 * relPath → 本机绝对路径。
 * 消费时把 `/` 转回本机（或该 root 的）分隔符：Windows 上 `path.win32.join` 得到 `C:\...`。
 * 本机没配置该 rootId 时先查 root 别名表（跨设备根名不一致的通病就靠它）；
 * 别名也没有才返回 null（= 条目存在但本机不可还原，只能展示）。
 */
export function fromRelPath(device, rootId, relPath) {
  const id = normalizeRootId(rootId);
  if (!id) return null;
  const localId = resolveLocalRootId(device, id);
  if (!localId) return null;
  const root = (device?.roots || []).find((r) => r.id === localId);
  if (!root || !root.path) return null;
  if (typeof relPath !== 'string') return null;
  const raw = relPath.replace(/\\/g, '/');
  if (isAbsoluteAnyPlatform(raw)) return null; // 只接受相对路径（兼容 POSIX 与 Windows 绝对路径写法）
  const rel = normalizeRelPath(raw);
  if (rel === null) return null;
  const join = separatorStyle(root.path) === '\\' ? path.win32.join : path.posix.join;
  const joined = rel === '' ? root.path : join(root.path, ...rel.split('/'));
  return canonicalPathFor(joined, device?.platform || process.platform);
}

/**
 * 跨设备稳定身份：rootId + relPath 是设备无关的，哈希出来的 id 两台机器一致。
 * 小写是因为 macOS/Windows 文件系统大小写不敏感，避免 /a/Foo 和 /a/foo 分叉。
 */
export function identityFromRoot(rootId, relPath) {
  const id = normalizeRootId(rootId);
  const rel = normalizeRelPath(relPath);
  if (!id || rel === null) return null;
  const syncKey = `root:${id}/${rel.normalize('NFC').toLowerCase()}`;
  return { syncId: stableId(syncKey), syncKey, rootId: id, relPath: rel, resolvable: true, path: null };
}

/**
 * 无法映射 root 的路径：用「来源设备 + 绝对路径」派生身份。
 * 这种条目不会和别的设备撞 id，但对端只能展示、不能播种。
 */
export function foreignIdentity(deviceId, absPath) {
  const raw = String(absPath ?? '')
    .replace(/\\/g, '/')
    .normalize('NFC')
    .replace(/\/+$/, '');
  if (!raw) return null;
  const syncKey = `foreign:${String(deviceId || 'unknown')}:${raw.toLowerCase()}`;
  return { syncId: stableId(syncKey), syncKey, rootId: null, relPath: null, resolvable: false, path: raw };
}

/**
 * 本机路径 → 同步身份（主入口）。
 * 能匹配 root 就是跨设备 id；否则退化成“本机专属 id”。
 */
export function identityForPath(device, absPath) {
  const rel = toRelPath(device, absPath);
  if (rel.resolvable) {
    const base = identityFromRoot(rel.rootId, rel.relPath);
    return { ...base, path: rel.absPath };
  }
  const platform = device?.platform || process.platform;
  const fallbackPath = rel.absPath ?? canonicalPathFor(absPath, platform);
  const foreign = foreignIdentity(device?.id, fallbackPath);
  if (!foreign) return null;
  return { ...foreign, path: fallbackPath, reason: rel.reason };
}

/** 给 CLI / doctor 用的概况 */
export function describeDevice(device, { home } = {}) {
  return {
    id: device?.id ?? null,
    name: device?.name ?? null,
    platform: device?.platform ?? null,
    home: home ?? null,
    roots: (device?.roots || []).map((r) => ({ id: r.id, path: r.path, priority: r.priority })),
    rootAliases: normalizeRootAliases(device?.rootAliases),
  };
}

/** 设备是否在运行期被手工改过（CLI 用来提示重启生效） */
export function assertDevice(device) {
  if (!device || typeof device !== 'object') throw new Error('device 必填');
  if (typeof device.id !== 'string' || !device.id.trim()) throw new Error('device.id 缺失；先 loadDevice() 或 createDevice()');
  return device;
}

/** 目录是否存在（device 模块内部只做展示提示，不做业务判定） */
export function rootExists(root) {
  try {
    return fs.statSync(root.path).isDirectory();
  } catch {
    return false;
  }
}
