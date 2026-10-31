/**
 * DSH（DeepSeek Harness）适配器
 *
 * 真相源：~/.dsh/storages/workspace.json
 *   { unit:{name:"workspace",version:2},
 *     global:{ initialized, workspaceIds:[uuid...], archivedSessionIds, pinnedSessionIds },
 *     tables:{ workspaces:{ "<uuid>":{ path, title, sessionIds:[], createdAt, updatedAt } } } }
 *
 * 说明：workspaceIds 决定顺序；tables.workspaces 存实体。两者要同时维护才一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, isRunningByCmdline } from '../lib/safety.mjs';
import { spawnCliDetached } from '../lib/platform.mjs';

const HOME = os.homedir();
const STATE = path.join(HOME, '.dsh', 'storages', 'workspace.json');

export default {
  id: 'dsh',
  name: 'DSH',
  kind: 'agent',
  capabilities: { read: true, seed: 'store-write', open: true, watch: true },
  statePaths: () => [STATE],

  async read() {
    const r = readJson(STATE);
    if (!r.ok) return { entries: [], error: r.error, statePath: STATE };
    const d = r.value || {};
    const ids = Array.isArray(d?.global?.workspaceIds) ? d.global.workspaceIds : [];
    const table = d?.tables?.workspaces || {};
    const entries = [];
    const push = (id, order) => {
      const w = table[id];
      if (!w || !w.path) return;
      entries.push({
        path: w.path,
        title: w.title || null,
        nativeId: id,
        lastActiveAt: w.updatedAt || null,
        order,
      });
    };
    ids.forEach((id, i) => push(id, i));
    // 表里有、index 里漏掉的（历史脏数据）也要收进来，否则会“看不见”
    let extraOrder = ids.length;
    for (const id of Object.keys(table)) {
      if (!ids.includes(id)) push(id, extraOrder++);
    }
    return { entries, statePath: STATE, note: `${entries.length} 个工作区` };
  },

  /** 打开：dsh 在目标目录启动（真实交互行为待 recon 确认） */
  async open(target) {
    spawnCliDetached('dsh', [], { cwd: target });
    return { ok: true, how: `dsh (cwd=${target})` };
  },

  async isRunning() {
    // Electron 进程名是 "DeepSeek Harness Helper"，-x 匹配不到；用启动路径匹配。
    // Windows 上进程路径形如 ...\dsh\lib\bin.js 或 DeepSeek Harness.exe。
    const patterns = process.platform === 'win32'
      ? ['DeepSeek Harness.exe', 'dsh\\lib\\bin.js']
      : ['DeepSeek Harness.app/Contents', 'dsh/lib/bin.js'];
    return isRunningByCmdline(patterns);
  },
};
