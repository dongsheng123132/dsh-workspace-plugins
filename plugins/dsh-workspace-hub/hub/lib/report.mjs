/**
 * 归集报告（report）：把账本渲染成人能读的「本机 AI 工具项目总览」。
 *
 * 三个纯函数，不读磁盘、不写文件、无第三方依赖：
 *   buildReport(ledger, { now, toolNames, exists })  → 结构化报告对象（可 JSON 序列化）
 *   renderMarkdown(report)                          → 中文 Markdown 字符串
 *   renderHtml(report)                              → 单文件 HTML 字符串（内联 CSS，无 JS）
 *
 * 为什么要纯函数：
 *   - 报告是「读」的产物，不该顺手改账本，也不该在测试里真去 stat 几百个目录
 *   - 目录是否还存在（僵尸判定）由调用方注入 exists，保持确定性
 *
 * 口径（与 README / research/05 盘点一致）：
 *   项目(projects)   = 除 app-managed 外的目录（app 自己生成的任务目录不算用户项目）
 *   僵尸(zombie)     = 目录已不存在（exists === false），优先级最高
 *   遗忘(stale)      = 还存在、且 kind=project、且 lastActiveAt 距今 ≥ 30 天
 *   长期遗忘         = 同上但 ≥ 90 天
 *   时间未知         = lastActiveAt 为空：既不算遗忘也不算新鲜，单独计数
 *   孤儿(orphans)    = 只出现在 1 个工具里的目录
 *   迁移建议         = 还存在、只在单个非目标工具里 → 建议补进目标工具（默认 DSH）
 */
import os from 'node:os';
import path from 'node:path';
import { renderTable, bar } from './render.mjs';

export const REPORT_VERSION = 1;
export const STALE_DAYS = 30;
export const STALE_DAYS_LONG = 90;
export const DEFAULT_TARGET_TOOL = 'dsh';
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- 转义 ----------

/** HTML 转义：项目名/路径都由第三方工具写入，必须当不可信文本处理 */
export function escapeHtml(input) {
  return String(input == null ? '' : input).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/**
 * Markdown 转义：除了 HTML 危险字符，还要转义表格分隔符与反引号，
 * 否则一个项目名里的 `|` 就能把整张表拆坏。换行压成空格。
 */
export function escapeMarkdown(input) {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ');
}

// ---------- 时间 ----------

/** 把 Date / 毫秒 / 秒 / ISO 字符串统一成毫秒；无效值退回当前时间 */
function resolveNowMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) {
    const t = now.getTime();
    return Number.isFinite(t) ? t : Date.now();
  }
  if (typeof now === 'number' && Number.isFinite(now)) {
    return now > 1e12 ? now : now * 1000;
  }
  const parsed = Date.parse(String(now));
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** 本机时区的 YYYY-MM-DD HH:mm（报告给人看，不用 UTC 干扰） */
export function formatTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 距今多少天（向下取整，负数按 0 处理） */
export function ageInDays(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

// ---------- 输入归一 ----------

/**
 * toolNames 归一化成 Map<toolId, { name, seed, note }>。
 * 允许四种写法（方便 CLI 直接塞 adapters）：
 *   Map{ id → 名字 | {name,seed,note} }
 *   [{ id, name, capabilities:{seed} }]（适配器对象原样传）
 *   [{ id, name }] / ['dsh','kimi']
 *   { dsh: 'DSH', kimi: { name:'Kimi CLI', seed:'cli' } }
 */
export function normalizeToolNames(toolNames) {
  const out = new Map();
  const put = (id, val) => {
    if (!id) return;
    const key = String(id);
    if (val == null) {
      out.set(key, { name: key, seed: null, note: null });
      return;
    }
    if (typeof val === 'string') {
      out.set(key, { name: val || key, seed: null, note: null });
      return;
    }
    if (typeof val === 'object') {
      out.set(key, {
        name: val.name || val.displayName || key,
        seed: val.seed ?? val.capabilities?.seed ?? null,
        note: val.note ?? null,
      });
    }
  };
  if (toolNames instanceof Map) {
    for (const [id, val] of toolNames) put(id, val);
  } else if (Array.isArray(toolNames)) {
    for (const item of toolNames) {
      if (item == null) continue;
      if (typeof item === 'string') put(item, item);
      else if (typeof item === 'object') put(item.id || item.key || item.name, item);
    }
  } else if (toolNames && typeof toolNames === 'object') {
    for (const [id, val] of Object.entries(toolNames)) put(id, val);
  }
  return out;
}

/** 目录是否存在：优先用注入的 exists（函数 / Set / 映射），其次看账本自带的 exists 字段 */
function makeExistsResolver(opts) {
  const injected = opts.exists ?? opts.existsFn;
  return function resolveExists(ws) {
    const p = ws?.path;
    if (!p) return false;
    if (typeof injected === 'function') return Boolean(injected(p));
    if (injected instanceof Set) return injected.has(p);
    if (injected && typeof injected === 'object' && p in injected) return Boolean(injected[p]);
    if (typeof ws.exists === 'boolean') return ws.exists;
    if (typeof ws.missing === 'boolean') return !ws.missing;
    // 账本不持久化 exists；没注入就按“存在”处理（纯函数不知道磁盘）
    return true;
  };
}

/** 展示用路径：home 前缀缩成 ~（和 paths.mjs 的 displayPath 同口径，但 home 可注入） */
function toDisplayPath(p, home) {
  if (!p) return '';
  if (!home) return p;
  if (p === home) return '~';
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return p.startsWith(prefix) ? '~' + p.slice(home.length) : p;
}

// ---------- buildReport ----------

/**
 * 把账本归集成报告对象。
 *
 * @param {object} ledger 账本：{ workspaces: [...] }（见 lib/ledger.mjs）
 * @param {object} [opts]
 * @param {Date|number|string} [opts.now]            生成时间（默认当前时间）；测试传固定值
 * @param {object} [opts.toolNames]                  工具 id → 展示名/seed（见 normalizeToolNames）
 * @param {Function|Set|object} [opts.exists]        目录存在性：path => boolean（CLI 传 fs.existsSync）
 * @param {string} [opts.home]                       家目录（决定 displayPath 的 ~ 缩写）
 * @param {number} [opts.staleDays]                  遗忘阈值（默认 30）
 * @param {number} [opts.staleDaysLong]              长期遗忘阈值（默认 90）
 * @param {string} [opts.targetTool]                 迁移建议的目标工具 id（默认 dsh）
 * @param {string} [opts.targetToolName]             目标工具展示名（默认 DSH）
 * @param {{staleTop?:number,zombieTop?:number,suggestionTop?:number}} [opts.limits]
 * @returns {object} 报告对象（纯数据，JSON.stringify 即可用）
 */
export function buildReport(ledger, opts = {}) {
  const nowMs = resolveNowMs(opts.now);
  const home = opts.home ?? os.homedir();
  const staleDays = Number.isFinite(opts.staleDays) ? opts.staleDays : STALE_DAYS;
  const staleDaysLong = Number.isFinite(opts.staleDaysLong) ? opts.staleDaysLong : STALE_DAYS_LONG;
  const targetTool = opts.targetTool || DEFAULT_TARGET_TOOL;
  const limits = {
    staleTop: opts.limits?.staleTop ?? 20,
    zombieTop: opts.limits?.zombieTop ?? 20,
    suggestionTop: opts.limits?.suggestionTop ?? 10,
  };
  const toolMeta = normalizeToolNames(opts.toolNames);
  const resolveExists = makeExistsResolver(opts);

  const workspaces = Array.isArray(ledger?.workspaces) ? ledger.workspaces.filter(Boolean) : [];

  // 覆盖率：一个目录被哪些工具收录（presentIn 去重，容忍适配器重复写同一 id）
  const coverageMap = new Map();
  const byTool = {};
  for (const ws of workspaces) {
    const ids = [...new Set((Array.isArray(ws.presentIn) ? ws.presentIn : []).filter(Boolean))];
    for (const id of ids) {
      coverageMap.set(id, (coverageMap.get(id) || 0) + 1);
      if (!byTool[id]) {
        byTool[id] = { id, name: toolMeta.get(id)?.name || id, count: 0, paths: [] };
      }
      byTool[id].paths.push(ws.path);
    }
  }

  // 工具清单：注册了但 0 个目录的工具也保留（用来暴露“装了但没读到”的覆盖缺口）
  const toolIds = [...new Set([...toolMeta.keys(), ...coverageMap.keys()])];
  const tools = toolIds
    .map((id) => {
      const meta = toolMeta.get(id);
      return {
        id,
        name: meta?.name || id,
        count: coverageMap.get(id) || 0,
        seed: meta?.seed ?? null,
        note: meta?.note ?? null,
      };
    })
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), 'zh-CN'));

  // 逐目录派生：状态优先级 = 僵尸 > 应用托管 > 遗忘 > 新鲜
  const projects = workspaces.map((ws) => {
    const kind = ws.kind || 'project';
    const exists = resolveExists(ws);
    const lastActiveAt = ws.lastActiveAt || null;
    const ageDays = ageInDays(lastActiveAt, nowMs);
    const toolIdsOfWs = [...new Set((Array.isArray(ws.presentIn) ? ws.presentIn : []).filter(Boolean))];
    let status;
    if (!exists) status = 'zombie';
    else if (kind === 'app-managed') status = 'app-managed';
    else if (ageDays != null && ageDays >= staleDays) status = 'stale';
    else status = 'fresh';
    return {
      path: ws.path,
      displayPath: toDisplayPath(ws.path, home),
      name: ws.displayName || (ws.path ? path.basename(ws.path) : ''),
      kind,
      tools: toolIdsOfWs,
      lastActiveAt,
      ageDays,
      status,
      exists,
      pinned: Boolean(ws.pinned),
      unknownAge: ageDays == null && status !== 'zombie',
    };
  });

  const staleAll = projects
    .filter((p) => p.status === 'stale')
    .sort((a, b) => b.ageDays - a.ageDays || String(a.path).localeCompare(String(b.path), 'zh-CN'));
  const zombieAll = projects
    .filter((p) => p.status === 'zombie')
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) || String(a.path).localeCompare(String(b.path), 'zh-CN'));
  const appManagedAll = projects.filter((p) => p.kind === 'app-managed' && p.status !== 'zombie');

  // 迁移建议：还存在、只在单个旧工具里、且那个工具不是目标工具 → 建议补进目标工具
  const targetName = opts.targetToolName || (toolMeta.get(targetTool)?.name ?? targetTool.toUpperCase());
  const suggestionsAll = projects
    .filter(
      (p) =>
        p.exists &&
        p.kind === 'project' &&
        p.tools.length === 1 &&
        p.tools[0] !== targetTool
    )
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1) || String(a.path).localeCompare(String(b.path), 'zh-CN'))
    .map((p) => {
      const onlyName = toolMeta.get(p.tools[0])?.name || p.tools[0];
      return {
        path: p.path,
        displayPath: p.displayPath,
        name: p.name,
        onlyIn: p.tools[0],
        onlyInName: onlyName,
        lastActiveAt: p.lastActiveAt,
        ageDays: p.ageDays,
        target: targetTool,
        reason: `只在 ${onlyName} 里，其它工具（含 ${targetName}）的侧栏看不到`,
      };
    });

  const coverage = [...coverageMap.entries()]
    .map(([id, count]) => [id, count])
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));

  const totals = {
    tools: coverageMap.size,
    toolsRegistered: tools.length,
    workspaces: workspaces.length,
    projects: projects.filter((p) => p.kind !== 'app-managed').length,
    appManaged: projects.filter((p) => p.kind === 'app-managed').length,
    missingDirs: zombieAll.length,
    orphans: projects.filter((p) => p.tools.length === 1).length,
    stale30: staleAll.length,
    stale90: staleAll.filter((p) => p.ageDays >= staleDaysLong).length,
    unknownAge: projects.filter((p) => p.unknownAge).length,
    pinned: projects.filter((p) => p.pinned).length,
  };

  const toolNamesMap = {};
  for (const t of tools) toolNamesMap[t.id] = t.name;

  return {
    version: REPORT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    generatedLabel: formatTime(nowMs),
    empty: workspaces.length === 0,
    thresholds: { staleDays, staleDaysLong },
    target: { id: targetTool, name: targetName },
    limits,
    totals,
    tools,
    toolNames: toolNamesMap,
    coverage,
    byTool,
    stale: staleAll,
    zombie: zombieAll,
    appManaged: appManagedAll,
    suggestions: suggestionsAll,
    projects,
  };
}

// ---------- Markdown ----------

function mdCell(value) {
  return escapeMarkdown(value == null || value === '' ? '—' : value);
}

function mdToolNames(report, ids) {
  return ids.map((id) => report.toolNames?.[id] || id).join('、');
}

/** 生成 Markdown 报告；空账本/全僵尸/全 app-managed 都返回可读文本，不抛错 */
export function renderMarkdown(report) {
  const r = report && typeof report === 'object' ? report : buildReport({ workspaces: [] });
  const { totals, thresholds, limits } = r;
  const out = [];
  const title = '本机 AI 工具项目总览';

  const unread = Math.max(0, (totals.toolsRegistered || 0) - (totals.tools || 0));
  out.push(`# ${title}`, '');
  out.push(
    `> 把 ${totals.tools} 个 AI 工具左侧的工作目录联邦成一份账本后生成的归集报告` +
      (unread ? `（另有 ${unread} 个已登记工具本次没读到目录）` : '') + '。',
    `> 生成时间：${r.generatedLabel || '—'} · 口径：≥${thresholds.staleDays} 天未动 = 遗忘，≥${thresholds.staleDaysLong} 天 = 长期遗忘，应用托管目录不计入项目。`,
    ''
  );

  // 总览
  out.push('## 总览', '');
  out.push('| 指标 | 数量 | 说明 |');
  out.push('| --- | ---: | --- |');
  out.push(`| 工具 | ${totals.tools} | 账本里至少收录 1 个目录的工具（另注册 ${totals.toolsRegistered} 个） |`);
  out.push(`| 目录 | ${totals.workspaces} | 各工具列表的并集条目 |`);
  out.push(`| 用户项目 | ${totals.projects} | 排除应用托管目录 ${totals.appManaged} 个 |`);
  out.push(`| 僵尸目录 | ${totals.missingDirs} | 磁盘上已不存在，仍占着某个侧栏 |`);
  out.push(`| 遗忘 ≥${thresholds.staleDays} 天 | ${totals.stale30} | 还在磁盘上、但很久没打开 |`);
  out.push(`| 遗忘 ≥${thresholds.staleDaysLong} 天 | ${totals.stale90} | 长期遗忘，可考虑归档 |`);
  out.push(`| 只在一个工具里 | ${totals.orphans} | 其它工具的侧栏看不到 |`);
  if (totals.unknownAge) out.push(`| 时间未知 | ${totals.unknownAge} | 该工具不提供最近活跃时间 |`);
  out.push('');

  if (r.empty) {
    out.push('> 账本还是空的：先跑 `wshub scan --save` 生成账本，再跑 `wshub report --md`。', '');
  }

  // 工具覆盖
  out.push('## 工具覆盖', '');
  if (!r.tools?.length) {
    out.push('_没有读到任何工具。_', '');
  } else {
    const maxCount = Math.max(1, ...r.tools.map((t) => t.count));
    const rows = r.tools.map((t) => ({
      tool: t.name,
      count: String(t.count).padStart(3, ' '),
      bar: bar(t.count, maxCount, 18),
      seed: t.seed || '—',
    }));
    out.push('```text');
    out.push(
      renderTable(
        [
          { key: 'tool', title: '工具' },
          { key: 'count', title: '覆盖' },
          { key: 'bar', title: '' },
          { key: 'seed', title: '可播种' },
        ],
        rows
      )
    );
    out.push('```', '');
    out.push('（覆盖 = 该工具列表里有多少个账本目录；可播种 = 适配器声明的写入能力。）', '');
  }

  // 被遗忘项目
  out.push(`## 被遗忘项目（Top ${limits.staleTop}）`, '');
  if (!r.stale?.length) {
    out.push('_没有超过阈值的项目，侧栏挺干净。_', '');
  } else {
    out.push('| 多久没动 | 项目 | 路径 | 只在 |');
    out.push('| ---: | --- | --- | --- |');
    for (const p of r.stale.slice(0, limits.staleTop)) {
      out.push(
        `| ${p.ageDays} 天 | ${mdCell(p.name)} | ${mdCell(p.displayPath)} | ${mdCell(mdToolNames(r, p.tools))} |`
      );
    }
    if (r.stale.length > limits.staleTop) {
      out.push('', `_还有 ${r.stale.length - limits.staleTop} 个未列出。_`);
    }
    out.push('');
  }

  // 僵尸目录
  out.push('## 僵尸目录（磁盘上已不存在）', '');
  if (!r.zombie?.length) {
    out.push('_没有僵尸目录。_', '');
  } else {
    out.push('| 路径（已删除） | 曾在 | 最近活跃 |');
    out.push('| --- | --- | --- |');
    for (const p of r.zombie.slice(0, limits.zombieTop)) {
      out.push(
        `| ${mdCell(p.displayPath)} | ${mdCell(mdToolNames(r, p.tools))} | ${mdCell(ageLabel(p))} |`
      );
    }
    if (r.zombie.length > limits.zombieTop) {
      out.push('', `_还有 ${r.zombie.length - limits.zombieTop} 个未列出。_`);
    }
    out.push('');
  }

  // 迁移建议
  out.push(`## 迁移建议（补进 ${r.target.name}）`, '');
  const targetId = r.target.id;
  const targetMissing = r.projects.filter(
    (p) => p.exists && p.kind === 'project' && !p.tools.includes(targetId)
  );
  if (!r.suggestions?.length) {
    out.push(`_没有需要迁移的项目：${r.target.name} 已经能看到所有单工具项目。_`, '');
  } else {
    out.push('| 项目 | 路径 | 只在 | 最近活跃 | 建议 |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const s of r.suggestions.slice(0, limits.suggestionTop)) {
      out.push(
        `| ${mdCell(s.name)} | ${mdCell(s.displayPath)} | ${mdCell(s.onlyInName)} | ${mdCell(ageLabel(s))} | 补进 ${mdCell(r.target.name)} |`
      );
    }
    if (r.suggestions.length > limits.suggestionTop) {
      out.push('', `_还有 ${r.suggestions.length - limits.suggestionTop} 个未列出。_`);
    }
    out.push('');
    out.push(
      `> 账本里另有 ${targetMissing.length} 个目录不在 ${r.target.name} 里；上表挑的是其中「只在单个旧工具出现」、最值得先补的 ${Math.min(r.suggestions.length, limits.suggestionTop)} 个（v0.2 的播种能力会把它们补进 ${r.target.name} 的左侧列表）。`,
      ''
    );
  }

  // 脚注：怎么复跑
  out.push('---', '');
  out.push('### 复跑', '');
  out.push('```bash');
  out.push('wshub scan --save     # 重新扫一遍各工具，写入账本');
  out.push('wshub report --md     # 生成本文');
  out.push('wshub report --html   # 生成单文件 HTML（浅色，可离线打开）');
  out.push('wshub report --json   # 结构化数据，给脚本/其它工具用');
  out.push('```', '');
  out.push(
    `_口径与代码见 \`hub/lib/report.mjs\`、\`hub/lib/ledger.mjs\`，说明见 \`docs/REPORT.md\`。_`,
    ''
  );
  return out.join('\n');
}

/** 「多少天没动」的人话标签 */
function ageLabel(p) {
  if (p.ageDays == null) return '时间未知';
  if (p.ageDays === 0) return '今天';
  return `${p.ageDays} 天前`;
}

// ---------- HTML ----------

const HTML_CSS = `
:root {
  --bg: #f6f8fa;
  --card: #ffffff;
  --line: #d0d7de;
  --soft: #eaeef2;
  --ink: #1f2328;
  --muted: #57606a;
  --accent: #1a5fb4;
  --accent-soft: #e8f0fa;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
}
.page { max-width: 1040px; margin: 0 auto; padding: 28px 20px 56px; }
.head { background: var(--card); border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: 8px; padding: 22px 24px; }
.brand { color: var(--accent); font-size: 13px; letter-spacing: 1px; }
h1 { margin: 6px 0 10px; font-size: 24px; line-height: 1.35; color: #14203a; }
.lede { margin: 0 0 8px; color: var(--ink); }
.meta { margin: 0; color: var(--muted); font-size: 13px; }
.stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin: 16px 0; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.stat .num { font-size: 26px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
.stat .label { color: var(--muted); font-size: 13px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 18px 22px 20px; margin: 16px 0; }
h2 { margin: 0 0 4px; font-size: 17px; color: #14203a; }
.sub { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
.table-wrap { width: 100%; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 10px; border-top: 1px solid var(--soft); vertical-align: top; }
thead th { border-top: 0; border-bottom: 1px solid var(--line); color: var(--muted); font-weight: 500; background: var(--bg); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.bar { display: block; width: 160px; height: 8px; background: var(--soft); border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); }
.path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--muted); word-break: break-all; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; border: 1px solid var(--line); color: var(--muted); background: var(--bg); }
.tag.accent { color: var(--accent); border-color: #b9cfe8; background: var(--accent-soft); }
.del { color: var(--muted); text-decoration: line-through; }
.empty { margin: 0; color: var(--muted); }
.foot { margin-top: 20px; color: var(--muted); font-size: 13px; }
.foot code { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; font-size: 12.5px; }
.foot ol { margin: 8px 0 0; padding-left: 20px; }
@media (max-width: 860px) { .stats { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 560px) {
  .page { padding: 16px 12px 40px; }
  h1 { font-size: 20px; }
  .stats { grid-template-columns: repeat(2, 1fr); }
  .card { padding: 14px 14px 16px; }
  .bar { width: 90px; }
}
`.trim();

function h(value) {
  return escapeHtml(value);
}

function statCard(num, label, tone = '') {
  return `<div class="stat"><div class="num${tone ? ' ' + tone : ''}">${h(num)}</div><div class="label">${h(label)}</div></div>`;
}

function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}" class="empty">${h(text)}</td></tr>`;
}

/** 生成单文件 HTML 报告；内联 CSS、无外部资源、无 JS，移动端可读 */
export function renderHtml(report) {
  const r = report && typeof report === 'object' ? report : buildReport({ workspaces: [] });
  const { totals, thresholds, limits } = r;
  const title = '本机 AI 工具项目总览';
  const unread = Math.max(0, (totals.toolsRegistered || 0) - (totals.tools || 0));
  const lede =
    `这是本机 AI 工具项目总览：${totals.tools} 个工具的 ${totals.workspaces} 个目录已归集成一份账本` +
    (unread ? `（另有 ${unread} 个已登记工具本次没读到目录）` : '') +
    `，其中 ${totals.projects} 个是用户项目；${totals.missingDirs} 个目录已被删除，${totals.stale30} 个项目超过 ${thresholds.staleDays} 天没动。`;

  const stats = [
    statCard(totals.tools, '收录工具'),
    statCard(totals.workspaces, '目录并集'),
    statCard(totals.projects, '用户项目'),
    statCard(totals.missingDirs, '僵尸目录'),
    statCard(totals.stale30, `遗忘 ≥${thresholds.staleDays} 天`),
    statCard(totals.stale90, `长期 ≥${thresholds.staleDaysLong} 天`),
  ].join('');

  // 工具覆盖
  const maxCount = Math.max(1, ...(r.tools || []).map((t) => t.count));
  const coverageRows = (r.tools || [])
    .map((t) => {
      const pct = Math.round((t.count / maxCount) * 100);
      return `<tr><td>${h(t.name)}</td><td class="num">${h(t.count)}</td><td><div class="bar" role="img" aria-label="覆盖比例 ${pct}%"><i style="width:${pct}%"></i></div></td><td>${t.seed ? `<span class="tag accent">${h(t.seed)}</span>` : '<span class="tag">只读</span>'}</td></tr>`;
    })
    .join('');
  const coverageTable = (r.tools || []).length
    ? `<div class="table-wrap"><table><thead><tr><th>工具</th><th class="num">覆盖</th><th>占比</th><th>可播种</th></tr></thead><tbody>${coverageRows}</tbody></table></div>`
    : `<p class="empty">没有读到任何工具。</p>`;

  // 被遗忘项目
  const staleRows = (r.stale || [])
    .slice(0, limits.staleTop)
    .map(
      (p) =>
        `<tr><td class="num">${h(p.ageDays)} 天</td><td>${h(p.name)}</td><td class="path">${h(p.displayPath)}</td><td>${h(mdToolNames(r, p.tools))}</td></tr>`
    )
    .join('');
  const staleTable = (r.stale || []).length
    ? `<div class="table-wrap"><table><thead><tr><th class="num">多久没动</th><th>项目</th><th>路径</th><th>只在</th></tr></thead><tbody>${staleRows}</tbody></table></div>`
    : `<p class="empty">没有超过阈值的项目，侧栏挺干净。</p>`;

  // 僵尸目录
  const zombieRows = (r.zombie || [])
    .slice(0, limits.zombieTop)
    .map(
      (p) =>
        `<tr><td class="path del">${h(p.displayPath)}</td><td>${h(mdToolNames(r, p.tools))}</td><td>${h(ageLabel(p))}</td></tr>`
    )
    .join('');
  const zombieTable = (r.zombie || []).length
    ? `<div class="table-wrap"><table><thead><tr><th>路径（已删除）</th><th>曾在</th><th>最近活跃</th></tr></thead><tbody>${zombieRows}</tbody></table></div>`
    : `<p class="empty">没有僵尸目录。</p>`;

  // 迁移建议
  const targetId = r.target.id;
  const targetMissing = (r.projects || []).filter(
    (p) => p.exists && p.kind === 'project' && !p.tools.includes(targetId)
  ).length;
  const sugRows = (r.suggestions || [])
    .slice(0, limits.suggestionTop)
    .map(
      (s) =>
        `<tr><td>${h(s.name)}</td><td class="path">${h(s.displayPath)}</td><td>${h(s.onlyInName)}</td><td>${h(ageLabel(s))}</td><td><span class="tag accent">补进 ${h(r.target.name)}</span></td></tr>`
    )
    .join('');
  const sugTable = (r.suggestions || []).length
    ? `<div class="table-wrap"><table><thead><tr><th>项目</th><th>路径</th><th>只在</th><th>最近活跃</th><th>建议</th></tr></thead><tbody>${sugRows}</tbody></table></div><p class="sub" style="margin-top:12px">账本里另有 ${h(targetMissing)} 个目录不在 ${h(r.target.name)} 里；上表挑的是其中「只在单个旧工具出现」、最值得先补的 ${h(Math.min((r.suggestions || []).length, limits.suggestionTop))} 个（v0.2 的播种能力会把它们补进 ${h(r.target.name)} 的左侧列表）。</p>`
    : `<p class="empty">没有需要迁移的项目：${h(r.target.name)} 已经能看到所有单工具项目。</p>`;

  const emptyNotice = r.empty
    ? `<p class="empty">账本还是空的：先跑 <code>wshub scan --save</code> 生成账本。</p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)}</title>
<style>
${HTML_CSS}
</style>
</head>
<body>
<main class="page">
  <header class="head">
    <div class="brand">工作目录中枢 · wshub</div>
    <h1>${h(title)}</h1>
    <p class="lede">${h(lede)}</p>
    <p class="meta">生成时间 ${h(r.generatedLabel || '—')} · 遗忘阈值 ${h(thresholds.staleDays)} 天 / 长期 ${h(thresholds.staleDaysLong)} 天 · 应用托管目录不计入项目</p>
  </header>
  ${emptyNotice}
  <section class="stats">${stats}</section>
  <section class="card">
    <h2>工具覆盖</h2>
    <p class="sub">覆盖 = 该工具左侧列表里有多少个账本目录；可播种 = 适配器声明的写入能力。</p>
    ${coverageTable}
  </section>
  <section class="card">
    <h2>被遗忘项目</h2>
    <p class="sub">还在磁盘上、但已经 ${h(thresholds.staleDays)} 天以上没打开的项目，按最久没动排序（Top ${h(limits.staleTop)}）。</p>
    ${staleTable}
  </section>
  <section class="card">
    <h2>僵尸目录</h2>
    <p class="sub">目录已被删除或改名，但仍挂在某个工具的左侧列表里，可以清掉。</p>
    ${zombieTable}
  </section>
  <section class="card">
    <h2>迁移建议（补进 ${h(r.target.name)}）</h2>
    <p class="sub">只出现在单个旧工具里的项目：其它工具的侧栏看不到，建议补进 ${h(r.target.name)}。</p>
    ${sugTable}
  </section>
  <footer class="foot">
    <strong>复跑</strong>
    <ol>
      <li><code>wshub scan --save</code> 重新扫一遍各工具，写入账本</li>
      <li><code>wshub report --html</code> 重新生成本页（另有 <code>--md</code> / <code>--json</code>）</li>
    </ol>
    <p style="margin:10px 0 0">口径与实现见 <code>hub/lib/report.mjs</code>、<code>hub/lib/ledger.mjs</code>，说明见 <code>docs/REPORT.md</code>。</p>
  </footer>
</main>
</body>
</html>
`;
  return html;
}
