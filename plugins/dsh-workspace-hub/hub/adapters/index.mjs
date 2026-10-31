/**
 * 适配器注册表。
 *
 * 新增一个工具 = 在这里加一个 adapter（实现 read，可选 seed/open/isRunning/statePaths），
 * 其余同步逻辑都不用改。
 *
 * 约定（Adapter Contract）：
 *   id            稳定短 id（会写进 ledger 的 sources）
 *   name          展示名
 *   kind          'agent' | 'ide' | 'gui'
 *   capabilities  { read, seed: 'rpc'|'cli'|'store-write'|'deeplink'|'ui'|'none', open, watch }
 *   statePaths()  需要监听/备份的状态文件
 *   read()        -> { entries:[{path,title?,nativeId?,lastActiveAt?,order?,kind?}], error?, statePath?, note? }
 *                   error 约定：not-found / unsupported / cloud-only / not-applicable
 *   seed(entries, ctx)  （v0.2）把账本条目写进该工具，必须自行备份+校验
 *   open(path)    在该工具里打开目录
 *   isRunning()   true/false/null
 *
 * 注意：
 *   - Claude 有两个适配器：CLI 的列表在 ~/.claude.json，桌面版在 claude-code-sessions，不同源
 *   - Codex 真相源是 state_5.sqlite（app-server 领域库），不是 electron 那个 JSON 镜像
 *   - 第一批之外的 8 个工具在 extra.mjs（Kimi/U-King/QwenWork/CodeBuddy/pi/Qoder/DeepSeek/Hermes）
 */
import dsh from './dsh.mjs';
import codexApp from './codex.mjs';
import claudeCode from './claude.mjs';
import claudeDesktop from './claude-desktop.mjs';
import workbuddy from './workbuddy.mjs';
import { trae, cursor, antigravity } from './vscode.mjs';
import {
  kimi,
  uking,
  qwenwork,
  codebuddy,
  pi,
  qoder,
  deepseekTui,
  hermes,
} from './extra.mjs';
import { doubao, doubaoWork } from './stubs.mjs';

// 剃刀规格（docs/SCOPE.md）：只承诺 6 个主力适配器；其余标 experimental，不承诺、不进测试矩阵。
const STABLE_ADAPTERS = new Set(['dsh', 'codex-app', 'claude-code', 'trae', 'cursor', 'workbuddy'])

export function getAdapters() {
  return [
    // 第一批（recon 已完成、写入策略明确）
    dsh,
    codexApp,
    claudeCode,
    claudeDesktop,
    trae(),
    cursor(),
    antigravity(),
    workbuddy,
    // 第二批（research/05 盘点发现，读取配方见报告）
    kimi,
    uking,
    qwenwork,
    codebuddy(),
    pi(),
    qoder(),
    deepseekTui,
    hermes,
    // 不适用 / 云端只读
    doubaoWork(),
    doubao(),
  ].map((a) => ({ ...a, stability: STABLE_ADAPTERS.has(a.id) ? 'stable' : 'experimental' }));
}

export function findAdapter(idOrName, adapters = getAdapters()) {
  const needle = String(idOrName || '').toLowerCase();
  return adapters.find((a) => a.id.toLowerCase() === needle || a.name.toLowerCase() === needle) || null;
}
