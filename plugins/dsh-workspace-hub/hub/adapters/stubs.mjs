/**
 * 明确“不做/做不了”的 GUI 工具占位适配器。
 *
 * 保留它们是为了在 scan 里**诚实显示**“未支持”，而不是假装读到 0 条。
 * 0 条（真没有工作目录）和读不出（格式未解）是两件完全不同的事。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDataCandidates } from '../lib/platform.mjs';

const HOME = os.homedir();

function probeAdapter({ id, name, candidates, error, note }) {
  return {
    id,
    name,
    kind: 'gui',
    capabilities: { read: false, seed: 'none', open: false, watch: false },
    statePaths: () => candidates,
    async read() {
      const existing = candidates.filter((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });
      return {
        entries: [],
        error,
        note: existing.length
          ? `${note}（找到数据目录：${[...new Set(existing.map((p) => path.basename(p)))].join(', ')}）`
          : note,
        statePath: existing[0] || null,
      };
    },
    async isRunning() {
      return null;
    },
    async open() {
      return { ok: false, error: `${name}：暂不支持从 wdhub 打开（${note}）` };
    },
  };
}

/** 普通豆包（App Store 沙箱）：纯聊天，没有“工作目录”概念 —— 不属于本工具的目标范围 */
export const doubao = () =>
  probeAdapter({
    id: 'doubao',
    name: '豆包（聊天版）',
    candidates: [
      // App Store 沙箱数据（仅 macOS）；其它平台候选由 appDataCandidates 按平台给出
      ...(process.platform === 'darwin' ? [path.join(HOME, 'Library', 'Containers', 'com.bot.neotix.doubao')] : []),
      ...appDataCandidates('Doubao'),
    ],
    error: 'not-applicable',
    note: '纯聊天，无工作目录',
  });

/**
 * 豆包·工作（DoubaoWork 2.34.4）
 * recon 结论：左栏 = 项目 + 最近对话，每个会话绑一个本地工作目录（~/DoubaoWork/chats/<日期>/new-chat*），
 * 但列表是云端下行缓存（pull_recent_conv_chain），本地 IndexedDB 为 V8 序列化；
 * 无 CLI，doubaowork:// 全是内部 webview 路由，无路径深链接 → **v1 无法静默播种**。
 */
export const doubaoWork = () =>
  probeAdapter({
    id: 'doubao-work',
    name: '豆包·工作',
    candidates: [...appDataCandidates('DoubaoWork'), path.join(HOME, 'DoubaoWork')],
    error: 'cloud-only',
    note: '云端下发+本地缓存，无官方接口',
  });
