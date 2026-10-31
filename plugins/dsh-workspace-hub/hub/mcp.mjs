#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * wshub MCP server（stdio，JSON-RPC 2.0，零依赖）。
 *
 * 为什么要 MCP：用户要求“最好是 AI 自然而然就能找到”。MCP 是现在 AI 工具
 * （Claude Code、Codex、Cursor、DSH…）通用的工具发现协议——只要在任一客户端里
 * 注册一次，模型就能自己看到 `workspaces_list` / `workspaces_sync` 这些能力，
 * 不用读文档猜命令。
 *
 * 注册示例（Claude Code）：
 *   claude mcp add workspace-hub -- node /path/to/hub/mcp.mjs
 * 其它工具：把下面这段加进 MCP 配置
 *   { "mcpServers": { "workspace-hub": { "command": "node", "args": ["/path/to/hub/mcp.mjs"] } } }
 */
import os from 'node:os';
import path from 'node:path';
import { getAdapters, findAdapter } from './adapters/index.mjs';
import { loadLedger, mergeObservations, emptyLedger, planForTool, summarize } from './lib/ledger.mjs';
import { displayPath } from './lib/paths.mjs';
import { nowIso } from './lib/safety.mjs';

const VERSION = '0.1.0';
const PROTOCOL = '2024-11-05';

function resolveHome() {
  if (process.env.WSHUB_HOME) return path.resolve(process.env.WSHUB_HOME);
  if (process.env.WDHUB_HOME) return path.resolve(process.env.WDHUB_HOME);
  return path.join(os.homedir(), '.workspace-hub');
}

async function readAll(adapters) {
  return Promise.all(
    adapters.map(async (a) => {
      try {
        const r = await a.read();
        return { adapter: a, entries: (r.entries || []).filter((e) => e && e.path), error: r.error || null };
      } catch (err) {
        return { adapter: a, entries: [], error: String(err?.message || err) };
      }
    })
  );
}

async function collect() {
  const adapters = getAdapters();
  const reads = await readAll(adapters);
  const ok = reads.filter((r) => !r.error);
  const { ledger } = loadLedger(resolveHome());
  const base = ledger.workspaces.length ? ledger : emptyLedger();
  const merged = mergeObservations(structuredClone(base), ok.flatMap((r) => r.entries.map((e) => ({ tool: r.adapter.id, ...e }))), {
    now: nowIso(),
    toolsSeen: ok.map((r) => r.adapter.id),
  }).ledger;
  return { adapters, reads, ledger: merged };
}

const TOOLS = [
  {
    name: 'workspaces_list',
    description:
      '列出本机所有 AI 工具（DSH/Codex/Claude/Trae/Cursor/WorkBuddy…）左侧「工作目录」的并集。每个目录会标注它出现在哪些工具里、最近活跃时间。用于回答“我有哪些项目/工作目录”。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：按路径或名字过滤' },
        limit: { type: 'number', description: '最多返回多少条，默认 100' },
      },
    },
  },
  {
    name: 'workspaces_plan',
    description:
      '生成“把哪些目录补进哪个工具”的播种计划（只读，不执行）。用于回答“还差哪些没同步”。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '每个工具最多列出多少条，默认 20' } },
    },
  },
  {
    name: 'workspaces_open',
    description: '在指定 AI 工具里打开一个工作目录（如 codex / dsh / claude-code / trae / cursor）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要打开的目录绝对路径' },
        tool: { type: 'string', description: '工具 id：' + getAdapters().map((a) => a.id).join(' / ') },
      },
      required: ['path', 'tool'],
    },
  },
];

async function callTool(name, args = {}) {
  if (name === 'workspaces_list') {
    const { reads, ledger } = await collect();
    const q = String(args.query || '').toLowerCase();
    const limit = Number(args.limit || 100);
    let items = ledger.workspaces.map((ws) => ({
      path: ws.path,
      displayPath: displayPath(ws.path),
      name: ws.displayName,
      kind: ws.kind || 'project',
      tools: ws.presentIn,
      lastActiveAt: ws.lastActiveAt,
      exists: !ws.missingDirs,
    }));
    if (q) items = items.filter((i) => `${i.displayPath} ${i.name}`.toLowerCase().includes(q));
    const total = items.length;
    items = items.slice(0, limit);
    const summary = summarize(ledger);
    return {
      total,
      returned: items.length,
      tools_read: Object.fromEntries(reads.map((r) => [r.adapter.id, r.error ? `error:${r.error}` : r.entries.length])),
      union: summary.total,
      orphans: summary.orphans.length,
      missingDirs: summary.missingDirs.length,
      appManaged: summary.appManaged.length,
      items,
    };
  }
  if (name === 'workspaces_plan') {
    const adapters = getAdapters();
    const { ledger } = await collect();
    const limit = Number(args.limit || 20);
    return {
      ledgerUpdatedAt: ledger.updatedAt,
      plans: adapters.map((a) => {
        const missing = planForTool(ledger, a.id, { limit });
        return {
          tool: a.id,
          name: a.name,
          seed: a.capabilities?.seed || 'none',
          missingCount: planForTool(ledger, a.id, { limit: Infinity }).length,
          missing: missing.map((ws) => displayPath(ws.path)),
        };
      }),
    };
  }
  if (name === 'workspaces_open') {
    const adapter = findAdapter(String(args.tool || ''));
    if (!adapter) throw new Error(`未知工具：${args.tool}`);
    if (!args.path) throw new Error('缺少 path');
    const target = path.resolve(args.path.replace(/^~(?=$|\/)/, os.homedir()));
    const r = await adapter.open?.(target);
    if (!r || r.ok === false) throw new Error(r?.error || `${adapter.name} 不支持打开`);
    return { ok: true, how: r.how };
  }
  throw new Error(`未知工具名：${name}`);
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  // 通知不需要回复
  if (method === 'notifications/initialized') return;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'workspace-hub', version: VERSION },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await callTool(name, args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: '错误：' + String(err?.message || err) }], isError: true });
    }
  }
  if (id != null) replyError(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, 'Parse error');
      continue;
    }
    handle(msg).catch((err) => {
      if (msg?.id != null) replyError(msg.id, -32603, String(err?.message || err));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
