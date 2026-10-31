#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * wdhub — 左侧工作目录同步器 CLI（v0.1：只读盘点 + 计划）
 *
 * 命令：
 *   wdhub scan [--save] [--json] [--limit N]   盘点各工具左侧工作目录，算并集与差异
 *   wdhub plan [--json]                        生成“给每个工具补哪些目录”的播种计划（不执行）
 *   wdhub status                               简短状态
 *   wdhub open <目录> --in <工具>              在指定工具里打开目录
 *   wdhub doctor                               环境与适配器自检
 *   wdhub discover                             发现本机所有 AI 工具（含还没适配的）
 *   wdhub mcp                                  MCP server（stdio），供 AI 工具直接调用
 *
 * 全局选项：--home <目录>（默认 ~/.wdhub，或环境变量 WDHUB_HOME）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapters, findAdapter } from './adapters/index.mjs';
import {
  loadLedger,
  saveLedger,
  emptyLedger,
  mergeObservations,
  planForTool,
  summarize,
  dataPaths,
} from './lib/ledger.mjs';
import { renderTable, truncateMiddle, bar } from './lib/render.mjs';
import { discover as discoverTools } from './lib/discover.mjs';
import { buildReport, renderMarkdown, renderHtml } from './lib/report.mjs';
import { gitSync, defaultRepoDir } from './lib/gitsync.mjs';
import { applyIntegrations, integrationStatus } from './lib/integrations.mjs';
import { analyzePrune, applyPrune, isDshRunning, lockMissingFromSidebar } from './lib/dshprune.mjs';
import { loadDevice, saveDevice, addRoot, removeRoot, describeDevice, rootExists, setRootAlias, removeRootAlias, normalizeRootAliases, resolveLocalRootId } from './lib/device.mjs';
import { sync as runSync, bootstrapLocalEvents } from './lib/sync.mjs';
import { displayPath, pathKey } from './lib/paths.mjs';
import { nowIso, isRunning } from './lib/safety.mjs';

const VERSION = '0.3.1';
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = paint('2');
const bold = paint('1');
const cyan = paint('36');
const yellow = paint('33');
const green = paint('32');
const red = paint('31');

// ---------- 参数 ----------
const VALUE_FLAGS = new Set(['home', 'limit', 'in', 'format', 'dir', 'add-root', 'remove-root', 'alias', 'unalias', 'days', 'out', 'stale-days', 'repo', 'repo-dir', 'interval', 'level', 'dsh-home']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key) && next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

function resolveHome(flags) {
  if (flags.home) return path.resolve(String(flags.home));
  if (process.env.WSHUB_HOME) return path.resolve(process.env.WSHUB_HOME);
  if (process.env.WDHUB_HOME) return path.resolve(process.env.WDHUB_HOME);
  return path.join(os.homedir(), '.workspace-hub');
}

// ---------- 读取 ----------
async function readAll(adapters) {
  return Promise.all(
    adapters.map(async (a) => {
      const t0 = Date.now();
      try {
        const r = await a.read();
        const entries = Array.isArray(r.entries) ? r.entries.filter((e) => e && e.path) : [];
        return {
          adapter: a,
          entries,
          error: r.error || null,
          note: r.note || null,
          statePath: r.statePath || (a.statePaths?.()[0] ?? null),
          ms: Date.now() - t0,
        };
      } catch (err) {
        return {
          adapter: a,
          entries: [],
          error: String(err?.message || err),
          note: null,
          statePath: a.statePaths?.()[0] ?? null,
          ms: Date.now() - t0,
        };
      }
    })
  );
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toolLabel(id, adapters) {
  const a = adapters.find((x) => x.id === id);
  return a ? a.name : id;
}

// ---------- scan ----------
async function cmdScan(ctx) {
  const { flags } = ctx;
  // 剃刀收口：这三个视图不再单独占命令，改为 scan 的开关
  if (flags.discover) return cmdDiscover(ctx);
  if (flags.forgotten) return cmdForgotten(ctx);
  if (flags.report) return cmdReport(ctx);
  const limit = Number(flags.limit || 20);
  const adapters = getAdapters();
  const reads = await readAll(adapters);
  const okReads = reads.filter((r) => !r.error);
  const observations = okReads.flatMap((r) => r.entries.map((e) => ({ tool: r.adapter.id, ...e })));

  const { ledger: previous } = loadLedger(ctx.home);
  const base = previous.workspaces.length ? previous : emptyLedger();
  const { ledger, changes } = mergeObservations(structuredClone(base), observations, {
    now: nowIso(),
    toolsSeen: okReads.map((r) => r.adapter.id),
    ...(flags['include-home'] ? { ignorePaths: [] } : {}),
  });
  const summary = summarize(ledger);

  if (flags.json) {
    const out = {
      version: VERSION,
      device: os.hostname(),
      generatedAt: nowIso(),
      home: ctx.home,
      adapters: reads.map((r) => ({
        id: r.adapter.id,
        name: r.adapter.name,
        kind: r.adapter.kind,
        capabilities: r.adapter.capabilities,
        statePath: r.statePath,
        count: r.entries.length,
        ok: !r.error,
        error: r.error,
        note: r.note,
      })),
      summary: {
        total: summary.total,
        orphans: summary.orphans.length,
        missingDirs: summary.missingDirs.length,
        perTool: Object.fromEntries(summary.perTool),
      },
      workspaces: ledger.workspaces.map((ws) => ({
        id: ws.id,
        path: ws.path,
        displayPath: displayPath(ws.path),
        name: ws.displayName,
        presentIn: ws.presentIn,
        lastActiveAt: ws.lastActiveAt,
        exists: fs.existsSync(ws.path),
      })),
    };
    console.log(JSON.stringify(out, null, 2));
    if (flags.save) saveLedger(ctx.home, ledger);
    return 0;
  }

  // 头部
  console.log('');
  console.log(bold(`wshub ${VERSION}`) + dim(' · Workspace Hub · 左侧工作目录盘点'));
  console.log(dim(`${os.hostname()} · ${fmtTime(nowIso())} · 账本 ${displayPath(dataPaths(ctx.home).ledger)}${base.workspaces.length ? '' : dim('（尚未保存）')}`));
  console.log('');

  // 各工具读取结果
  const rows = reads.map((r) => {
    const status = r.error
      ? r.error === 'unsupported'
        ? yellow('格式未解')
        : r.error === 'cloud-only'
          ? yellow('云端·不可写')
          : r.error === 'not-applicable'
            ? dim('不适用')
            : r.error === 'not-found'
              ? dim('未安装/无数据')
              : red('读取失败')
      : green(`${r.entries.length} 个`);
    return {
      tool: r.adapter.stability === 'experimental' ? r.adapter.name + dim('·实验') : r.adapter.name,
      count: status,
      state: r.error && r.error !== 'not-found' ? truncateMiddle(String(r.note || r.error), 46) : truncateMiddle(String(r.statePath || ''), 46),
    };
  });
  console.log(renderTable(
    [
      { key: 'tool', title: '工具' },
      { key: 'count', title: '读到' },
      { key: 'state', title: '状态 / 数据文件' },
    ],
    rows
  ));

  // 汇总
  const maxCount = Math.max(1, ...summary.perTool.values());
  console.log('');
  console.log(
    `并集 ${bold(String(summary.total))} 个目录 · ` +
      `只出现在 1 个工具 ${summary.orphans.length ? yellow(String(summary.orphans.length)) : '0'} 个 · ` +
      `目录已不存在 ${summary.missingDirs.length ? red(String(summary.missingDirs.length)) : '0'} 个` +
      (summary.appManaged.length ? dim(` · 应用托管目录 ${summary.appManaged.length} 个（默认不播种）`) : '') +
      (changes.ignored ? dim(` · 忽略系统目录 ${changes.ignored} 条`) : '')
  );
  console.log('');
  const perToolRows = [...summary.perTool.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({
      tool: toolLabel(id, adapters),
      n: String(n).padStart(3, ' '),
      bar: bar(n, maxCount, 18),
    }));
  console.log(renderTable(
    [
      { key: 'tool', title: '工具' },
      { key: 'n', title: '  覆盖' },
      { key: 'bar', title: '' },
    ],
    perToolRows
  ));

  // 重灾区：只在一个工具里
  const orphans = summary.orphans
    .slice()
    .sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')))
    .slice(0, limit);
  if (orphans.length) {
    console.log('');
    console.log(bold('只在一个工具里出现（其它工具的侧栏看不到）'));
    console.log(renderTable(
      [
        { key: 'path', title: '目录', width: 62 },
        { key: 'tool', title: '只在' },
        { key: 'last', title: '最近活跃' },
      ],
      orphans.map((ws) => ({
        path: truncateMiddle(displayPath(ws.path), 62) + (ws.kind === 'app-managed' ? dim(' ·app托管') : ''),
        tool: toolLabel(ws.presentIn[0], adapters),
        last: fmtTime(ws.lastActiveAt),
      }))
    ));
    if (summary.orphans.length > orphans.length) {
      console.log(dim(`  …还有 ${summary.orphans.length - orphans.length} 个，用 --limit 调大`));
    }
  }

  // 全部（按最近活跃）
  console.log('');
  console.log(bold(`全部目录（按最近活跃，前 ${Math.min(limit, ledger.workspaces.length)} 个）`));
  console.log(renderTable(
    [
      { key: 'path', title: '目录', width: 58 },
      { key: 'tools', title: '出现于' },
      { key: 'last', title: '最近活跃' },
    ],
    ledger.workspaces.slice(0, limit).map((ws) => ({
      path: truncateMiddle(displayPath(ws.path), 58),
      tools: ws.presentIn.length === adapters.filter((a) => !a.capabilities || a.capabilities.read).length ? green('全部') : ws.presentIn.map((t) => toolLabel(t, adapters)).join('+'),
      last: fmtTime(ws.lastActiveAt),
    }))
  ));

  if (flags.save) {
    saveLedger(ctx.home, ledger);
    console.log('');
    console.log(green(`已保存账本 → ${dataPaths(ctx.home).ledger}`));
  } else {
    console.log('');
    console.log(dim('提示：加 --save 保存账本（后续 plan / 云端同步都以账本为准）'));
  }
  console.log('');
  return 0;
}

// ---------- plan ----------
async function cmdPlan(ctx) {
  const { flags } = ctx;
  const adapters = getAdapters();
  const { ledger, error } = loadLedger(ctx.home);
  if (!ledger.workspaces.length) {
    console.log(yellow('账本还是空的。先跑一次：wdhub scan --save'));
    return 1;
  }
  const includeKinds = flags['include-app-managed'] ? ['project', 'app-managed'] : ['project'];
  const plans = [];
  for (const a of adapters) {
    const cap = a.capabilities || {};
    const all = planForTool(ledger, a.id, { limit: Infinity, includeKinds });
    const missing = all.slice(0, Number(flags.limit || 20));
    plans.push({ adapter: a, missing, missingCount: all.length, cap });
  }

  if (flags.json) {
    console.log(JSON.stringify({
      version: VERSION,
      ledgerUpdatedAt: ledger.updatedAt,
      plans: plans.map((p) => ({
        id: p.adapter.id,
        name: p.adapter.name,
        seed: p.cap.seed,
        missing: p.missing.map((ws) => ({ path: ws.path, displayPath: displayPath(ws.path), kind: ws.kind || 'project', exists: fs.existsSync(ws.path) })),
      })),
    }, null, 2));
    return 0;
  }

  console.log('');
  console.log(bold('播种计划') + dim(`（账本 ${displayPath(dataPaths(ctx.home).ledger)} · ${fmtTime(ledger.updatedAt)}）`));
  console.log('');
  const rows = plans.map((p) => {
    const seed = p.cap.seed;
    const how =
      seed === 'rpc' ? green('官方 RPC（最安全）')
        : seed === 'cli' ? 'CLI 打开'
          : seed === 'store-write' ? '退出后写原生存储'
            : seed === 'deeplink' ? '深链接（UI 入口）'
              : seed === 'ui' ? 'UI 自动化'
                : seed === 'unknown' ? yellow('待定')
                  : dim('不支持写入');
    return {
      tool: p.adapter.name,
      missing: String(p.missingCount).padStart(3, ' '),
      how,
    };
  });
  console.log(renderTable(
    [
      { key: 'tool', title: '工具' },
      { key: 'missing', title: '缺' },
      { key: 'how', title: '播种方式' },
    ],
    rows
  ));
  for (const p of plans) {
    if (!p.missingCount) continue;
    console.log('');
    console.log(bold(`${p.adapter.name}`) + dim(` 将被补入 ${p.missingCount} 个目录：`));
    for (const ws of p.missing.slice(0, 8)) {
      console.log('  + ' + displayPath(ws.path) + dim(ws.lastActiveAt ? `  (${fmtTime(ws.lastActiveAt)})` : ''));
    }
    if (p.missingCount > 8) console.log(dim(`  …还有 ${p.missingCount - 8} 个`));
  }
  console.log('');
  console.log(dim('注意：v0.1 只出计划不执行。播种执行器（含备份/校验/回滚）在 v0.2，见 docs/DESIGN.md'));
  console.log('');
  return 0;
}

// ---------- status ----------
async function cmdStatus(ctx) {
  const adapters = getAdapters();
  const reads = await readAll(adapters);
  const { ledger, error } = loadLedger(ctx.home);
  const okReads = reads.filter((r) => !r.error);
  if (!ledger.workspaces.length) {
    console.log(yellow('还没有账本。跑：wdhub scan --save'));
  }
  const merged = mergeObservations(structuredClone(ledger.workspaces.length ? ledger : emptyLedger()), okReads.flatMap((r) => r.entries.map((e) => ({ tool: r.adapter.id, ...e }))), {
    now: nowIso(),
    toolsSeen: okReads.map((r) => r.adapter.id),
  }).ledger;
  const summary = summarize(merged);
  const lines = [
    `账本      ${ledger.workspaces.length} 个目录 ${ledger.updatedAt ? dim(fmtTime(ledger.updatedAt)) : dim('(空)')}`,
    `当前并集  ${summary.total} 个 · 孤儿 ${summary.orphans.length} 个 · 僵尸 ${summary.missingDirs.length} 个`,
    `工具      ${reads.map((r) => `${r.adapter.name}:${r.error ? '×' : r.entries.length}`).join('  ')}`,
  ];
  if (error) lines.push(red(`账本读取失败：${error}`));
  console.log('');
  console.log(lines.join('\n'));
  console.log('');
  return 0;
}

// ---------- open ----------
async function cmdOpen(ctx) {
  const { flags, positional } = ctx;
  const raw = positional[1];
  if (!raw) {
    console.log('用法：wdhub open <目录> --in <codex|dsh|claude-code|trae|cursor>');
    return 1;
  }
  const adapters = getAdapters();
  const target = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
  const want = flags.in || flags.tool;
  if (!want) {
    console.log('需要 --in 指定工具。可用：' + adapters.map((a) => a.id).join(', '));
    return 1;
  }
  const adapter = findAdapter(String(want), adapters);
  if (!adapter) {
    console.log(red(`未知工具：${want}`));
    return 1;
  }
  const r = await adapter.open?.(target);
  if (!r || r.ok === false) {
    console.log(red(r?.error || '该工具暂不支持 open'));
    return 1;
  }
  console.log(green('已打开：') + r.how);
  return 0;
}

// ---------- dsh-prune（清理 DSH 左侧工作区）----------
async function cmdDshPrune(ctx) {
  const { flags } = ctx;
  const dshHome = flags['dsh-home'] ? path.resolve(String(flags['dsh-home'])) : undefined;

  // 只锁「账本里还有、但当前侧栏没有」的路径：不碰 workspace.json，DSH 开着也能跑。
  if (flags['lock-exclude']) {
    const res = lockMissingFromSidebar({
      dshHome,
      hubHome: ctx.home,
      dryRun: Boolean(flags['dry-run'] || flags.dryRun),
    });
    if (flags.json) { console.log(JSON.stringify(res, null, 2)); return 0; }
    console.log('');
    console.log(bold('锁定「手动删掉、但账本里还在」的工作区') + (res.dryRun ? dim('（预演）') : ''));
    console.log(renderTable(
      [{ key: 'k', title: '指标' }, { key: 'v', title: '值' }],
      [
        { k: '当前侧栏', v: String(res.sideCount) },
        { k: '账本条目', v: String(res.ledgerCount) },
        { k: '本次锁定', v: String(res.added.length) },
        { k: '屏蔽名单总数', v: String(res.total) },
      ]
    ));
    if (res.added.length > 0) {
      console.log('\n新锁定（前 8 个）：');
      for (const p of res.added.slice(0, 8)) console.log('  - ' + dim(p));
    }
    console.log('');
    if (res.dryRun) {
      console.log(dim('这是预演，不会改动任何文件。确认后运行：'));
      console.log(dim('  wshub dsh-prune --lock-exclude'));
    } else {
      console.log(green('已写入屏蔽名单：') + res.excludeFile);
      console.log(dim('插件以后不会再把这些路径补回侧栏（可逆：从该 JSON 里删掉对应行即可）。'));
    }
    console.log('');
    return 0;
  }

  const level = String(flags.level || 'medium');
  const analysis = analyzePrune(dshHome, level);

  if (flags.json) { console.log(JSON.stringify(analysis, null, 2)); return flags.apply ? 0 : 0; }
  console.log('');
  console.log(bold('DSH 左侧工作区清理') + dim(`（档位 ${level}）`));
  console.log(renderTable(
    [{ key: 'k', title: '指标' }, { key: 'v', title: '值' }],
    [
      { k: '当前工作区', v: String(analysis.total) },
      { k: '保留', v: String(analysis.keepCount) },
      { k: '删除', v: red(String(analysis.removeList.length)) },
    ]
  ));
  console.log('\n删除原因：');
  for (const [reason, count] of Object.entries(analysis.byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${reason}`);
  }
  console.log('\n示例（前 8 个）：');
  for (const e of analysis.removeList.slice(0, 8)) console.log(`  - [${e.reason}] ${e.title || e.path}  ${dim(e.path)}`);
  console.log('');

  if (!flags.apply) {
    console.log(dim('这是预演，不会改动任何文件。确认后先退出 DSH，再运行：'));
    console.log(dim(`  wshub dsh-prune --apply --level ${level}`));
    console.log(dim('只想锁住「手动删掉、账本里还在」的路径（不用退 DSH）：wshub dsh-prune --lock-exclude'));
    return 0;
  }
  if (isDshRunning()) {
    console.log(red('DSH 正在运行，不能直接写 workspace.json（退出后会被内存覆盖）。'));
    console.log(dim('请先完全退出 DSH，再运行本命令；或用桌面上的「清理DSH工作区.command」一键完成。'));
    return 2;
  }
  const res = applyPrune(analysis, { dshHome, hubHome: ctx.home });
  console.log(green('已清理：') + `删除 ${res.removed} 个，保留 ${res.kept} 个`);
  console.log(dim(`备份：${res.backup}`));
  console.log(dim(`屏蔽清单：${res.excludeFile}（插件以后不会再补这些路径）`));
  console.log('');
  return 0;
}

// ---------- sync（统一入口：GitHub / 共享目录）----------
async function cmdSyncUnified(ctx) {
  const { flags } = ctx;
  if (flags.dir) return cmdSync(ctx); // 共享目录 / U 盘模式
  const repoUrl = flags.repo || process.env.WSHUB_GIT_REPO;
  if (repoUrl) return cmdGitSync(ctx); // GitHub 模式
  console.log(yellow('用法：wshub sync --repo <GitHub 私有仓>  或  wshub sync --dir <共享目录>'));
  console.log(dim('GitHub 模式会 pull → 合并账本 → push；共享目录模式用于 U 盘/离线兜底。'));
  console.log(dim('环境变量：WSHUB_GIT_REPO 可作为 --repo 的默认值。'));
  return 1;
}

// ---------- device ----------
function cmdDevice(ctx) {
  const { flags } = ctx;
  const home = ctx.home;
  const loaded = loadDevice(home);
  let device = loaded.device;
  let changed = loaded.created;

  if (flags['add-root']) {
    const root = addRoot(device, String(flags['add-root']));
    if (root) { saveDevice(home, device); changed = true; }
  }
  if (flags['remove-root']) {
    const removed = removeRoot(device, String(flags['remove-root']));
    if (removed) { saveDevice(home, device); changed = true; }
  }
  // --alias <远端rootId>=<本机rootId>，支持逗号分隔多条
  if (flags.alias && flags.alias !== true) {
    const pairs = String(flags.alias).split(',').map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const [from, to] = pair.split('=').map((s) => (s || '').trim());
      if (!from || !to) { console.log(yellow(`别名格式不对：${pair}（要 <远端rootId>=<本机rootId>）`)); return 1; }
      if (!device.roots.some((r) => r.id === to)) {
        console.log(yellow(`本机没有 root "${to}"，别名 ${from}=${to} 现在不会生效（先 --add-root 或用已有 root id）`));
      }
      if (device.roots.some((r) => r.id === from)) {
        console.log(yellow(`本机已经有同名 root "${from}"，解析时会优先用它、别名不会生效；要覆盖请先 wshub device --remove-root ${from}`));
      }
      try { setRootAlias(device, from, to); } catch (err) { console.log(yellow(String(err.message))); return 1; }
      saveDevice(home, device); changed = true;
    }
  }
  if (flags.unalias && flags.unalias !== true) {
    for (const from of String(flags.unalias).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (removeRootAlias(device, from)) { saveDevice(home, device); changed = true; }
    }
  }

  const aliases = normalizeRootAliases(device.rootAliases);
  if (flags.json) {
    console.log(JSON.stringify(describeDevice(device, { home }), null, 2));
    return 0;
  }
  console.log('');
  console.log(bold('设备身份') + dim(` · ${changed ? '已更新' : '就绪'} · ${displayPath(loaded.path)}`));
  console.log(`  名称      ${device.name}`);
  console.log(`  id        ${device.id}`);
  console.log(`  平台      ${device.platform}`);
  console.log('');
  console.log(bold('路径根（跨设备同步时用来对齐路径）'));
  for (const root of device.roots) {
    const ok = rootExists(root);
    console.log(`  ${ok ? green('存在') : red('缺失')}  ${displayPath(root.path)}  ${dim('优先级 ' + root.priority + ' · id ' + root.id)}`);
  }
  console.log('');
  console.log(bold('root 别名（远端根名 → 本机根名，跨设备根名不一致时用）'));
  const aliasKeys = Object.keys(aliases);
  if (!aliasKeys.length) {
    console.log(dim('  （空。若同步后发现「对端条目只能列出、打不开」，按提示加：wshub device --alias <对端rootId>=<本机rootId>）'));
  } else {
    for (const from of aliasKeys) {
      const to = aliases[from];
      const ok = device.roots.some((r) => r.id === to);
      console.log(`  ${ok ? green('生效') : red('目标缺失')}  ${from} → ${to}`);
    }
  }
  console.log('');
  console.log(dim('增删根目录：wshub device --add-root <路径> / --remove-root <路径>'));
  console.log(dim('增删别名：  wshub device --alias <远端rootId>=<本机rootId>[,<远端>=<本机>...] / --unalias <远端rootId>'));
  console.log('');
  return 0;
}

// ---------- sync ----------
async function cmdSync(ctx) {
  const { flags } = ctx;
  const home = ctx.home;
  const syncDir = flags.dir || process.env.WSHUB_SYNC_DIR;
  if (!syncDir) {
    console.log(yellow('缺少同步目录。用法：wshub sync --dir <共享目录>'));
    console.log(dim('共享目录可以是 iCloud Drive / Syncthing / Git 工作副本里的一个文件夹。'));
    console.log(dim('也可以设环境变量 WSHUB_SYNC_DIR 后直接 wshub sync。'));
    return 1;
  }
  const loaded = loadDevice(home);
  const device = loaded.device;

  // 每次同步前都把“账本里有、还没变成同步事件”的条目播种掉（幂等、很便宜）。
  // 否则 scan --save 新发现的项目不会变成事件，对端永远看不到。
  {
    const { ledger } = loadLedger(home);
    if (ledger.workspaces.length) {
      const r = bootstrapLocalEvents(home, device, ledger);
      const n = (r?.emitted || r?.events || []).length;
      if (n) console.log(green('把本地账本播种成同步事件：') + `新增 ${n} 条 · 跳过（已同步过）${r?.skipped ?? 0} 条`);
    }
  }

  const dryRun = Boolean(flags['dry-run']);
  const res = runSync(syncDir, { home, device, dryRun, snapshot: Boolean(flags.snapshot) });

  // 跨设备事件里可能带回家目录/无法解析的远端条目（只加不减），保存前统一清掉：
  // 家目录不是工作区；没有本地路径的条目无法播种，只保留在远端事件日志里即可。
  const homeKey = pathKey(os.homedir());
  res.ledger.workspaces = res.ledger.workspaces.filter(
    (w) => w.path && pathKey(w.path) !== homeKey
  );
  if (!dryRun) saveLedger(home, res.ledger);

  if (flags.json) {
    console.log(JSON.stringify({
      device: { id: res.device.id, name: res.device.name },
      syncDir: res.syncDir,
      dryRun,
      stats: res.stats,
      changes: res.changes,
      workspaces: res.ledger.workspaces.length,
    }, null, 2));
    return 0;
  }

  console.log('');
  console.log(bold('跨设备同步') + dim(` · 设备 ${res.device.name} · 共享目录 ${displayPath(res.syncDir)}`));
  console.log('');
  console.log(renderTable(
    [
      { key: 'k', title: '项目' },
      { key: 'v', title: '值' },
    ],
    [
      { k: '合并后账本', v: String(res.ledger.workspaces.length) + ' 个目录' },
      { k: '收集事件', v: String(res.stats.collectedEvents) + ' 条（来自 ' + String(res.stats.devices) + ' 台设备）' },
      { k: '本地事件', v: String(res.stats.localEvents) + ' 条' },
      { k: '新增（对端可见）', v: String((res.changes?.added || []).length) },
      { k: '更新', v: String((res.changes?.updated || []).length) },
      { k: '删除（墓碑）', v: String((res.changes?.removed || []).length) },
      { k: '重复事件', v: String(res.stats.duplicateEvents) },
      { k: '坏行/忽略', v: String(res.stats.badLines) + ' / ' + String(res.stats.ignoredLines) },
    ]
  ));
  console.log('');
  // 未映射 root 的提示：这是跨设备同步最常见的一个坑（两边根名对不上）。
  const unmapped = res.stats?.unmappedRoots || {};
  const rootIds = device.roots.map((r) => r.id);
  const aliasable = Object.entries(unmapped)
    .filter(([rid]) => rid !== '(no-root)' && rid !== 'null' && !resolveLocalRootId(device, rid))
    .sort((a, b) => b[1] - a[1]);
  if (aliasable.length) {
    console.log(yellow('有对端条目在本机打不开（root 名对不上）：'));
    for (const [rid, count] of aliasable) {
      console.log(`  ${rid}: ${count} 条  → wshub device --alias ${rid}=${rootIds[0] || 'code'}`);
    }
    console.log(dim('  上面把「对端的 root」映射到「本机已有的 root id」。本机可用 root id：' + rootIds.join(', ')));
    console.log(dim('  设好后重跑 wshub sync，这批条目就会还原成本机路径（同名项目会按路径各自保留一条）。'));
    console.log('');
  }
  if (dryRun) {
    console.log(yellow('dry-run：未写账本、未发布本地事件。去掉 --dry-run 才会真正执行。'));
  } else {
    console.log(green('已保存账本：') + displayPath(dataPaths(home).ledger));
    console.log(dim('提示：首次接入先跑 wshub scan --save，再 wshub sync --bootstrap --dir <目录>'));
  }
  console.log('');
  return 0;
}

// ---------- adopt / remove（手动登记目录）----------
function cmdAdopt(ctx) {
  const { flags, positional } = ctx;
  const dirs = positional.slice(1);
  if (!dirs.length) {
    console.log('用法：wshub adopt <目录> [<目录>...]   把任意目录登记为受管工作区（之后 DSH 插件就能同步它）');
    return 1;
  }
  const { ledger } = loadLedger(ctx.home);
  const base = ledger.workspaces.length ? ledger : emptyLedger();
  const observations = dirs
    .map((d) => path.resolve(d.replace(/^~(?=$|\/)/, os.homedir())))
    .filter((p) => {
      if (p === os.homedir()) {
        console.log(yellow(`跳过家目录（不是工作区）：${p}`));
        return false;
      }
      return true;
    })
    .map((p) => ({
      tool: 'manual',
      path: p,
      title: null,
      // WorkBuddy 每任务自动生成的时间戳目录属于 app 托管，不该当用户项目
      kind: p.startsWith(path.join(os.homedir(), 'WorkBuddy') + path.sep) ? 'app-managed' : 'project',
    }));
  if (!observations.length) return 1;
  const { ledger: merged, changes } = mergeObservations(structuredClone(base), observations, {
    now: nowIso(),
    toolsSeen: ['manual'],
  });
  saveLedger(ctx.home, merged);
  if (flags.json) {
    console.log(JSON.stringify({ added: changes.added.map((w) => w.path), ledger: dataPaths(ctx.home).ledger }, null, 2));
    return 0;
  }
  console.log('');
  console.log(green(`已登记 ${observations.length} 个目录到账本`) + dim(`  ${displayPath(dataPaths(ctx.home).ledger)}`));
  for (const ob of observations) console.log('  + ' + displayPath(ob.path));
  console.log('');
  console.log(dim('下一步：在 DSH 里说「同步工作区」（或重启 DSH 让它启动时自动同步）。'));
  console.log('');
  return 0;
}

function cmdRemove(ctx) {
  const { flags, positional } = ctx;
  const dirs = positional.slice(1);
  if (!dirs.length) {
    console.log('用法：wshub remove <目录> [<目录>...]   从账本里移除目录（不影响任何 AI 工具）');
    return 1;
  }
  const { ledger } = loadLedger(ctx.home);
  const keys = new Set(
    dirs.map((d) => pathKey(path.resolve(d.replace(/^~(?=$|\/)/, os.homedir()))))
  );
  const before = ledger.workspaces.length;
  ledger.workspaces = ledger.workspaces.filter((w) => !keys.has(w.key) && !keys.has(pathKey(w.path)));
  ledger.updatedAt = nowIso();
  saveLedger(ctx.home, ledger);
  const removed = before - ledger.workspaces.length;
  if (flags.json) {
    console.log(JSON.stringify({ removed }, null, 2));
    return 0;
  }
  console.log(green(`已从账本移除 ${removed} 个目录`) + dim('（DSH 里已创建的工作区不会自动删，需要你在侧栏手动删）'));
  return 0;
}

// ---------- integrations（把 Codex/Claude/WorkBuddy 接上自动扫描同步）----------
async function cmdIntegrations(ctx) {
  const { flags } = ctx;
  const repoUrl = flags.repo || process.env.WSHUB_GIT_REPO;
  if (flags.apply) {
    if (!repoUrl) {
      console.log(yellow('--apply 需要 --repo <GitHub 私有仓地址>（或 WSHUB_GIT_REPO）'));
      return 1;
    }
    const res = applyIntegrations({
      repoUrl,
      backupHome: ctx.home,
      daemon: !flags['no-daemon'],
      intervalSeconds: Number(flags.interval || 600),
    });
    if (flags.json) { console.log(JSON.stringify(res, null, 2)); return res.ok ? 0 : 2; }
    console.log('');
    console.log(bold('接入安装结果') + dim(`  备份：${res.backupRoot}`));
    console.log(renderTable(
      [{ key: 'id', title: '项目' }, { key: 'ok', title: '结果' }, { key: 'detail', title: '说明' }],
      res.results.map((r) => ({
        id: r.id,
        ok: r.ok === false ? red('失败') : r.skipped ? dim('跳过') : r.changed ? green('已写入') : dim('已存在'),
        detail: truncateMiddle(String(r.error || r.reason || r.file || ''), 58),
      }))
    ));
    console.log('');
    console.log(dim('提示：Claude Code / Codex / WorkBuddy 需要重开一次会话/应用才加载 hook 与 MCP。'));
    console.log('');
    return res.ok ? 0 : 2;
  }

  const status = integrationStatus();
  if (flags.json) { console.log(JSON.stringify(status, null, 2)); return 0; }
  console.log('');
  console.log(bold('AI 工具接入状态') + dim(`（${status.repoRoot}）`));
  console.log(renderTable(
    [
      { key: 'name', title: '工具' },
      { key: 'mcp', title: 'MCP' },
      { key: 'hook', title: '启动自动同步' },
      { key: 'config', title: '配置', width: 52 },
    ],
    status.tools.map((t) => ({
      name: t.name,
      mcp: t.mcp ? green('已接') : yellow('未接'),
      hook: t.hook ? green('已接') : yellow('未接'),
      config: truncateMiddle(t.config || t.note || '', 52),
    }))
  ));
  console.log('');
  console.log(`定时兜底（launchd）：${status.launchd.loaded ? green('运行中') : dim('未安装')}   ${dim(status.launchd.file)}`);
  console.log(`共享 skill：${status.skill ? green('已安装') : dim('未安装')}   ~/.agents/skills/workspace-hub`);
  console.log('');
  console.log(dim('安装/更新：wshub integrations --apply --repo <GitHub 私有仓地址>'));
  console.log('');
  return 0;
}

// ---------- git-sync / auto（GitHub 跨设备同步）----------
async function cmdGitSync(ctx) {
  const { flags } = ctx;
  const repoUrl = flags.repo || process.env.WSHUB_GIT_REPO;
  if (!repoUrl) {
    console.log(yellow('缺少仓库地址。用法：wshub git-sync --repo git@github.com:你/workspace-hub-sync.git'));
    console.log(dim('也可以设 WSHUB_GIT_REPO 环境变量。私有仓需要本机已有 git 凭据（gh auth 或 SSH key）。'));
    return 1;
  }
  const repoDir = flags['repo-dir'] ? path.resolve(String(flags['repo-dir'])) : defaultRepoDir(ctx.home);
  const dryRun = Boolean(flags['dry-run']);
  const push = flags['no-push'] ? false : true;
  const res = gitSync({ repoUrl, repoDir, home: ctx.home, push, dryRun });

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 2;
  }
  console.log('');
  console.log(bold('GitHub 账本同步') + dim(`（${displayPath(repoDir)}）`));
  console.log(renderTable(
    [
      { key: 'k', title: '步骤' },
      { key: 'v', title: '结果' },
    ],
    [
      { k: '仓库', v: repoUrl },
      { k: '拉取', v: res.pull?.ok ? (res.pull.skipped ? '跳过（首次推送）' : '成功') : red('失败：' + (res.pull?.error || '')) },
      { k: '合并后账本', v: String(res.sync?.workspaces ?? '?') + ' 条' },
      { k: '本地事件 / 收集事件', v: String(res.sync?.stats?.localEvents ?? '?') + ' / ' + String(res.sync?.stats?.collectedEvents ?? '?') },
      { k: '提交', v: res.commit?.skipped ? dim('无变更') : res.commit?.ok ? green('已提交并推送') : red('失败：' + (res.commit?.error || '')) },
    ]
  ));
  console.log('');
  if (dryRun) console.log(yellow('dry-run：不写账本、不提交、不推送。'));
  return res.ok ? 0 : 2;
}

async function cmdAuto(ctx) {
  const { flags } = ctx;
  const home = ctx.home;
  const repoUrl = flags.repo || process.env.WSHUB_GIT_REPO;
  const steps = { repo: repoUrl || null, pull: null, scan: null, push: null };

  if (repoUrl) {
    const pullRes = gitSync({ repoUrl, home, push: false });
    steps.pull = { ok: pullRes.ok, workspaces: pullRes.sync?.workspaces ?? null, error: pullRes.pull?.error || pullRes.error || null };
    if (!pullRes.ok) {
      if (flags.json) console.log(JSON.stringify(steps, null, 2));
      else console.log(red('拉取/合并失败：') + (steps.pull.error || '未知错误'));
      return 2;
    }
    if (!flags.json) console.log(green('已拉取并合并远端账本：') + steps.pull.workspaces + ' 条');
  }

  // 扫描本机各 AI 工具（子进程跑 scan，保证 --json 输出干净）
  const scanProc = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'scan', '--save', '--json', '--home', home], {
    encoding: 'utf8',
    timeout: 180000,
  });
  try {
    const parsed = JSON.parse(scanProc.stdout || '{}');
    steps.scan = { ok: scanProc.status === 0, total: parsed.summary?.total ?? null, adapters: parsed.adapters?.filter((a) => a.ok).length ?? null };
  } catch {
    steps.scan = { ok: false, error: String(scanProc.stderr || 'scan output parse failed').slice(-500) };
  }

  if (repoUrl) {
    const pushRes = gitSync({ repoUrl, home, push: true });
    steps.push = { ok: pushRes.commit?.ok ?? false, committed: pushRes.commit?.committed ?? false, error: pushRes.commit?.error || pushRes.error || null };
    if (!flags.json) {
      console.log(steps.push.ok ? green('已推送本次变更到 GitHub') : red('推送失败：') + (steps.push.error || '未知错误'));
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(steps, null, 2));
    return steps.pull && steps.pull.ok === false ? 2 : 0;
  }
  console.log('');
  console.log(bold('自动同步完成') + dim('（拉取 → 扫描本机 → 推送）'));
  console.log(`  拉取：${steps.pull ? (steps.pull.ok ? green('成功') : red('失败')) : dim('未配置仓库')}`);
  console.log(`  扫描：${steps.scan?.ok ? green(String(steps.scan.total) + ' 条目录 / ' + String(steps.scan.adapters) + ' 个工具') : red('失败')}`);
  console.log(`  推送：${steps.push ? (steps.push.ok ? green('成功') : red('失败')) : dim('未配置仓库')}`);
  console.log('');
  return steps.scan?.ok ? 0 : 2;
}

// ---------- report ----------
async function cmdReport(ctx) {
  const { flags } = ctx;
  const adapters = getAdapters();
  const reads = await readAll(adapters);
  const okReads = reads.filter((r) => !r.error);
  const { ledger: previous } = loadLedger(ctx.home);
  const base = previous.workspaces.length ? previous : emptyLedger();
  const { ledger } = mergeObservations(structuredClone(base), okReads.flatMap((r) => r.entries.map((e) => ({ tool: r.adapter.id, ...e }))), {
    now: nowIso(),
    toolsSeen: okReads.map((r) => r.adapter.id),
  });
  const report = buildReport(ledger, {
    now: nowIso(),
    toolNames: adapters,
    exists: (p) => fs.existsSync(p),
    staleDays: Number(flags['stale-days'] || 30),
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  if (flags.html) {
    const out = path.resolve(String(flags.out || 'workspace-hub-report.html'));
    fs.writeFileSync(out, renderHtml(report), 'utf8');
    console.log(green('已生成 HTML 项目总览：') + out);
    console.log(dim('用浏览器打开即可；浅色卡片 + 单蓝强调，无外部依赖。'));
    return 0;
  }
  const md = renderMarkdown(report);
  if (flags.out) {
    const out = path.resolve(String(flags.out));
    fs.writeFileSync(out, md, 'utf8');
    console.log(green('已生成 Markdown 总览：') + out);
  } else {
    console.log(md);
  }
  return 0;
}

// ---------- forgotten ----------
async function cmdForgotten(ctx) {
  const { flags } = ctx;
  const days = Number(flags.days || 30);
  const limit = Number(flags.limit || 30);
  const adapters = getAdapters();
  const reads = await readAll(adapters);
  const okReads = reads.filter((r) => !r.error);
  const { ledger: previous } = loadLedger(ctx.home);
  const base = previous.workspaces.length ? previous : emptyLedger();
  const { ledger } = mergeObservations(structuredClone(base), okReads.flatMap((r) => r.entries.map((e) => ({ tool: r.adapter.id, ...e }))), {
    now: nowIso(),
    toolsSeen: okReads.map((r) => r.adapter.id),
  });
  const cutoff = Date.now() - days * 86400000;
  const stale = ledger.workspaces
    .filter((ws) => (ws.kind || 'project') === 'project')
    .filter((ws) => fs.existsSync(ws.path))
    .filter((ws) => {
      const t = ws.lastActiveAt ? Date.parse(ws.lastActiveAt) : 0;
      return !t || t < cutoff;
    })
    .sort((a, b) => String(a.lastActiveAt || '').localeCompare(String(b.lastActiveAt || '')));
  const shown = stale.slice(0, limit);

  if (flags.json) {
    console.log(JSON.stringify({
      days,
      total: stale.length,
      items: shown.map((ws) => ({ path: ws.path, displayPath: displayPath(ws.path), lastActiveAt: ws.lastActiveAt, tools: ws.presentIn })),
    }, null, 2));
    return 0;
  }

  const noDate = stale.filter((ws) => !ws.lastActiveAt).length;
  console.log('');
  console.log(bold(`好久没动的项目（≥${days} 天，共 ${stale.length} 个）`));
  console.log(dim('按最后活跃时间从旧到新排序；这些目录还在磁盘上，只是没有工具再提起它们。'));
  if (noDate) console.log(dim(`其中 ${noDate} 个在账本里没有任何时间戳（更可能是“彻底忘了”）。`));
  console.log('');
  console.log(renderTable(
    [
      { key: 'path', title: '项目', width: 54 },
      { key: 'last', title: '最后活跃' },
      { key: 'age', title: '距今' },
      { key: 'tools', title: '曾出现在' },
    ],
    shown.map((ws) => {
      const t = ws.lastActiveAt ? Date.parse(ws.lastActiveAt) : null;
      const ageDays = t ? Math.floor((Date.now() - t) / 86400000) : null;
      return {
        path: truncateMiddle(displayPath(ws.path), 54),
        last: fmtTime(ws.lastActiveAt),
        age: ageDays == null ? dim('未知') : ageDays >= 180 ? red(ageDays + ' 天') : ageDays >= 30 ? yellow(ageDays + ' 天') : ageDays + ' 天',
        tools: ws.presentIn.map((id) => toolLabel(id, adapters)).join('+'),
      };
    })
  ));
  if (stale.length > shown.length) console.log(dim(`  …还有 ${stale.length - shown.length} 个，用 --limit 调大`));
  console.log('');
  return 0;
}

// ---------- discover ----------
async function cmdDiscover(ctx) {
  const { flags } = ctx;
  const adapters = getAdapters();
  const result = discoverTools({ supportedAdapterIds: adapters.map((a) => a.id) });

  const supportedRows = adapters
    .filter((a) => a.capabilities?.read)
    .map((a) => ({
      name: a.name,
      id: a.id,
      file: truncateMiddle(displayPath((a.statePaths?.() || [])[0] || ''), 56),
      seed: a.capabilities.seed || 'none',
    }));

  if (flags.json) {
    console.log(JSON.stringify({ ...result, adapters: adapters.map((a) => ({ id: a.id, name: a.name, seed: a.capabilities?.seed, state: (a.statePaths?.() || [])[0] || null })) }, null, 2));
    return 0;
  }

  console.log('');
  console.log(bold('本机 AI 工具发现') + dim(` · ${result.device} · ${fmtTime(result.generatedAt)}`));
  console.log('');

  console.log(bold(`已支持（${supportedRows.length} 个，能读左侧工作目录）`));
  console.log(renderTable(
    [
      { key: 'name', title: '工具' },
      { key: 'file', title: '数据落点', width: 56 },
      { key: 'seed', title: '写入方式' },
    ],
    supportedRows
  ));
  console.log('');

  console.log(bold(`已发现但还没适配（${result.totals.candidate} 个）`));
  if (result.groups.candidate.length) {
    console.log(renderTable(
      [
        { key: 'name', title: '工具' },
        { key: 'version', title: '版本' },
        { key: 'paths', title: '数据落点', width: 54 },
        { key: 'last', title: '最后改动' },
      ],
      result.groups.candidate.map((r) => ({
        name: r.name,
        version: r.version || '—',
        paths: truncateMiddle(r.paths[0] || '', 54),
        last: fmtTime(r.lastTouched),
      }))
    ));
  } else {
    console.log(dim('  （无）'));
  }
  console.log('');

  if (result.groups.lowConfidence.length) {
    const names = result.groups.lowConfidence.slice(0, 12).map((x) => x.name);
    console.log(
      dim(
        `另有 ${result.groups.lowConfidence.length} 个低置信度目录（可能只是配置残留）：${names.join('、')}` +
          (result.groups.lowConfidence.length > names.length ? ' …' : '')
      )
    );
    console.log('');
  }
  console.log(dim('说明：关键词 + 已知目录匹配，可能多报漏报；全程只读，不碰任何 app 数据。'));
  console.log(dim('下一步：把候选里真有项目列表的工具补成 adapter，见 research/05-ai-tools-inventory.md'));
  console.log('');
  return 0;
}

// ---------- doctor ----------// ---------- doctor ----------
async function cmdDoctor(ctx) {
  const adapters = getAdapters();
  console.log('');
  console.log(bold('环境自检'));
  console.log(`  node          ${process.version}`);
  console.log(`  平台          ${process.platform} / ${os.arch()}`);
  console.log(`  账本目录      ${displayPath(ctx.home)} ${fs.existsSync(ctx.home) ? green('存在') : dim('未创建')}`);
  let sqlite = 'node:sqlite 可用';
  try {
    await import('node:sqlite');
  } catch {
    sqlite = 'node:sqlite 不可用（将退回 sqlite3 CLI）';
  }
  console.log(`  SQLite        ${sqlite}`);
  console.log('');
  console.log(bold('适配器'));
  const rows = [];
  for (const a of adapters) {
    const paths = (a.statePaths?.() || []).filter(Boolean);
    const existing = paths.filter((p) => fs.existsSync(p));
    let running = null;
    try {
      running = await a.isRunning?.();
    } catch {
      running = null;
    }
    rows.push({
      tool: a.name,
      id: a.id,
      state: existing.length ? green('有数据') : dim('无'),
      running: running === true ? '运行中' : running === false ? dim('未运行') : dim('未知'),
      seed: a.capabilities?.seed || '—',
      file: truncateMiddle(existing[0] ? displayPath(existing[0]) : paths[0] ? displayPath(paths[0]) : '—', 52),
    });
  }
  console.log(renderTable(
    [
      { key: 'tool', title: '工具' },
      { key: 'state', title: '数据' },
      { key: 'running', title: '进程' },
      { key: 'seed', title: '播种' },
      { key: 'file', title: '状态文件' },
    ],
    rows
  ));
  console.log('');
  return 0;
}

// ---------- help ----------
function usage() {
  console.log(`
${bold('wshub')} ${VERSION} — 把本机各 AI 工具左侧的「工作目录」联邦成一份账本，同步进 DSH，并用 GitHub 跨电脑合并。

**只读别家的状态，只写自己的账本；DSH 是唯一被写侧栏的工具。**

用法：
  ${bold('wshub setup')} [--apply --repo <地址>] [--json]   一次性接入：DSH 插件 + Claude/Codex/WorkBuddy 启动同步 + MCP + 定时兜底
  ${bold('wshub scan')}  [--save] [--json] [--report] [--forgotten] [--discover]
                                            读本机各 AI 工具 → 账本（--report 出总览 / --forgotten 找被遗忘 / --discover 找未适配）
  ${bold('wshub sync')}  --repo <地址> | --dir <目录> [--dry-run] [--no-push]
                                            跨设备合并：GitHub 私有仓（主通道）或共享目录（U 盘/离线兜底）
  ${bold('wshub open')}  <目录> --in <工具id>               在指定 AI 工具里打开目录

全局选项：
  --home <目录>   账本目录（默认 ~/.workspace-hub，可用 WSHUB_HOME 覆盖）
  --json          机器可读输出
  --limit N       列表条数（默认 20）

隐藏高级命令（不占帮助首页）：dsh-prune / device / adopt / remove / mcp / doctor / integrations / auto / git-sync
  其中 dsh-prune 支持：--apply --level light|medium|aggressive（清侧栏，需退 DSH）
                     / --lock-exclude（把「账本有、侧栏没有」的路径写进屏蔽名单，不用退 DSH）
  其中 device 支持：--add-root <路径> / --remove-root <id> / --alias <远端rootId>=<本机rootId> / --unalias <远端rootId>
  跨设备根名对不上（例：Windows 1new-code ↔ Mac code）时，用 --alias 让对端条目在本机可打开；
  每次 wshub sync 都会列出「未映射 root + 条数」并给出可复制的命令，详见 docs/ROOTS-ALIAS.md。
工具 id：${getAdapters().map((a) => a.id).join(', ')}
稳定承诺：DSH / Codex / Claude Code / Cursor / Trae / WorkBuddy（其余标「实验」）

安全边界：scan/setup 只读；不同步会话内容、不写别家状态文件、不含凭据。
详见 docs/SCOPE.md（范围规格）、docs/INTEGRATIONS.md、docs/GITHUB-SYNC.md
`);
}

// ---------- main ----------
async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] || 'scan';
  const ctx = { flags, positional, home: resolveHome(flags) };
  switch (cmd) {
    case 'scan':
      return cmdScan(ctx);
    case 'plan':
      return cmdPlan(ctx);
    case 'status':
      return cmdStatus(ctx);
    case 'open':
      return cmdOpen(ctx);
    case 'doctor':
      return cmdDoctor(ctx);
    case 'forgotten':
      return cmdForgotten(ctx);
    case 'report':
      return cmdReport(ctx);
    case 'adopt':
      return cmdAdopt(ctx);
    case 'remove':
      return cmdRemove(ctx);
    case 'discover':
      return cmdDiscover(ctx);
    case 'device':
      return cmdDevice(ctx);
    case 'dsh-prune':
      return cmdDshPrune(ctx);
    case 'git-sync':
      return cmdGitSync(ctx);
    case 'integrations':
      return cmdIntegrations(ctx);
    case 'auto':
      return cmdAuto(ctx);
    case 'sync':
      return cmdSyncUnified(ctx);
    case 'setup':
      return cmdIntegrations(ctx);
    case 'mcp':
      console.log(dim('启动 MCP server（stdio）。注册示例：claude mcp add workspace-hub -- node ' + fileURLToPath(import.meta.url).replace(/wdhub\\.mjs$/, 'mcp.mjs')));
      await import('./mcp.mjs');
      return 0;
    case 'version':
    case '-v':
    case '--version':
      console.log(VERSION);
      return 0;
    case 'help':
    case '-h':
    case '--help':
      usage();
      return 0;
    default:
      console.log(red(`未知命令：${cmd}`));
      usage();
      return 1;
  }
}

// 注意：不能用 process.exit() —— 大 JSON 走管道时（例如插件 spawnSync 解析 `scan --json`），
// Node 的 console.log 是异步写，process.exit 会把未 flush 的输出截断（本次实测踩到 90KB 截到 60KB）。
// 用 exitCode 让事件循环自然排空 stdout/stderr。
main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error(red('wdhub 出错：') + (err?.stack || err));
    process.exitCode = 1;
  });
