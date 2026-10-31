/**
 * Claude Code 适配器
 *
 * 真相源：~/.claude.json → projects: { "<绝对路径>": { lastSessionId, lastSessionModified, lastStartTime, ... } }
 * 每个目录一旦用 claude 打开过就会留下一条；桌面版 Claude 的 Claude Code 面板通常读同一份。
 *
 * 注意：条目没有可靠的“最近活跃时间”（部分条目缺 lastStartTime），
 * 这里 lastActiveAt 取 lastSessionModified || lastStartTime，缺失则为 null；
 * 数组顺序来自 JSON 插入序，不是活跃序，仅用于展示。
 */
import os from 'node:os';
import path from 'node:path';
import { readJson, isRunningByCmdline } from '../lib/safety.mjs';
import { isAbsoluteAnyPlatform, spawnCliDetached } from '../lib/platform.mjs';

const HOME = os.homedir();
const STATE = path.join(HOME, '.claude.json');

export default {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'agent',
  capabilities: { read: true, seed: 'cli', open: true, watch: true },
  statePaths: () => [STATE],

  async read() {
    const r = readJson(STATE);
    if (!r.ok) return { entries: [], error: r.error, statePath: STATE };
    const projects = r.value?.projects || {};
    const entries = [];
    Object.entries(projects).forEach(([p, meta], idx) => {
      if (!p || !isAbsoluteAnyPlatform(p)) return;
      entries.push({
        path: p,
        title: path.basename(p) || null,
        nativeId: p,
        lastActiveAt: meta?.lastSessionModified || meta?.lastStartTime || null,
        order: idx,
      });
    });
    return { entries, statePath: STATE, note: `${entries.length} 个项目` };
  },

  async isRunning() {
    // ~/.claude.json 被 CLI 与桌面版双写，两者任一在跑都不安全
    const patterns = process.platform === 'win32'
      ? ['claude-code\\cli.js', 'Claude.exe']
      : ['claude-code/cli.js', 'Claude.app/Contents'];
    return isRunningByCmdline(patterns);
  },

  /** 在目标目录启动 claude（会进入交互式会话；Windows 上经 cmd.exe 解析 claude.cmd） */
  async open(target) {
    spawnCliDetached('claude', [], { cwd: target });
    return { ok: true, how: `claude (cwd=${target})` };
  },
};
