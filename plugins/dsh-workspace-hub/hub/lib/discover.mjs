/**
 * 工具发现：把本机上所有“像 AI 工具”的东西找出来。
 *
 * 用户的原话：“ai 工具很多，散落在各个 ai 里边，有些我自己都忘记了”。
 * 这个模块负责回答三个问题：
 *   1. 这台机器上装了哪些 AI 工具？（应用安装目录 + 家目录隐藏目录 + 应用数据目录）
 *   2. 哪些已经有适配器（能读项目列表）？哪些发现了但还读不出？
 *   3. 哪些是纯聊天/无关，不用管？
 *
 * 跨平台（macOS / Windows / Linux）：
 *   - 应用安装根用 platform.scanAppDirs()：/Applications ↔ Program Files / %LOCALAPPDATA%\Programs ↔ /opt
 *   - 应用数据根用 platform.appDataRoots()：Application Support ↔ %APPDATA%/%LOCALAPPDATA% ↔ .config/.local/share
 *   - 家目录里的点目录三平台一致（~/.codex、~/.dsh、~/.claude ...）
 *
 * 只读，不改任何东西。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appDataRoots, scanAppDirs } from './platform.mjs';

/** 判断“可疑 AI 工具”的关键词（中英混合）。宁多勿少，最后人工看。 */
const AI_HINT = /(ai[-_. ]?|codex|claude|chatgpt|gpt|copilot|cursor|trae|windsurf|zed|warp|qoder|comate|codebuddy|kimi|moonshot|doubao|豆包|qwen|通义|tongyi|lingma|hermes|magpie|lobster|openclaw|continue|cline|roo|fitten|marscode|codegeex|aider|opencode|gemini|antigravity|deepseek|harness|workbuddy|bolt|lovable|perplexity|monica|sider|poe|jan|lmstudio|ollama|dify|n8n|comfyui|agent|agently|uking|u-claw|uclaw|beatra|cagent)/i;

/** 家目录里明显不是 AI 工具、但名字可能误命中的目录，直接排除 */
const HOME_SKIP = new Set([
  '.Trash', '.DS_Store', '.ssh', '.gnupg', '.cache', '.npm', '.nvm', '.local', '.config',
  '.oh-my-zsh', '.zsh', '.zsh_history', '.zshrc', '.zprofile', '.zshenv', '.bash_history',
  '.bashrc', '.bash_profile', '.profile', '.viminfo', '.lesshst', '.node_repl_history',
  '.python_history', '.CFUserTextEncoding', '.gitconfig', '.gitignore', '.docker', '.kube',
  '.conda', '.pyenv', '.rustup', '.cargo', '.gradle', '.m2', '.android', '.gradle', '.rbenv',
  '.pm2', '.yarnrc', '.npmrc', '.tool-versions', '.dspy_cache', '.homebrew', '.aspnet', '.dotnet',
  '.cocoapods', '.fastlane', '.appstoreconnect', '.asc', '.foundry', '.bytertc', '.aliyun',
  // Windows 家目录里的系统/无关目录
  'AppData', 'Application Data', 'Contacts', 'Cookies', 'Favorites', 'Links', 'Local Settings',
  'My Documents', 'NetHood', 'PrintHood', 'Recent', 'SendTo', 'Templates', 'NTUSER.DAT',
  'ntuser.dat', 'OneDrive', 'Searches', 'Saved Games', 'Videos', 'Music', 'Pictures',
]);

/** Windows 应用数据根下明显不是 AI 工具的目录（避免把系统/安装目录当候选） */
const WINDOWS_APPDATA_SKIP = new Set([
  'Adobe', 'Comms', 'ConnectedDevicesPlatform', 'D3DSCache', 'Google', 'Microsoft',
  'MicrosoftEdge', 'NVIDIA', 'NVIDIA Corporation', 'Packages', 'PackagesLocalState',
  'Programs', 'Temp', 'Tmp', 'pip', 'npm-cache', 'node-gyp', 'Yarn', 'pnpm', 'pnpm-cache',
  'PackagesLocalState', 'ssh',
]);

/** 已知工具登记表：命中则给出“已支持/候选”判断与落点提示 */
const CATALOG = [
  { key: 'dsh', name: 'DSH', adapter: 'dsh', match: /deepseek harness|\.dsh$/i },
  { key: 'codex', name: 'Codex', adapter: 'codex-app', match: /codex|chatgpt\.app/i },
  { key: 'claude', name: 'Claude Code / Claude 桌面版', adapter: 'claude-code,claude-desktop', match: /claude/i },
  { key: 'trae', name: 'Trae', adapter: 'trae', match: /trae/i },
  { key: 'cursor', name: 'Cursor', adapter: 'cursor', match: /cursor/i },
  { key: 'antigravity', name: 'Antigravity', adapter: 'antigravity', match: /antigravity/i },
  { key: 'workbuddy', name: 'WorkBuddy', adapter: 'workbuddy', match: /workbuddy/i },
  { key: 'doubaowork', name: '豆包·工作', adapter: 'doubao-work', match: /doubaowork/i },
  { key: 'doubao', name: '豆包（聊天版）', adapter: null, match: /^doubao$/i },
  { key: 'atlas', name: 'ChatGPT Atlas（浏览器）', adapter: null, match: /openai\.atlas/i },
  { key: 'comet', name: 'Comet（浏览器）', adapter: null, match: /^comet$/i },
  { key: 'gemini', name: 'Gemini CLI', adapter: null, match: /gemini/i },
  { key: 'hermes', name: 'Hermes', adapter: 'hermes', match: /hermes/i },
  { key: 'kimi', name: 'Kimi CLI', adapter: 'kimi', match: /kimi|moonshot/i },
  { key: 'qwen', name: 'QwenWork', adapter: 'qwenwork', match: /qwen|tongyi|lingma|qwenwork/i },
  { key: 'uking', name: 'U-King', adapter: 'uking', match: /u-?king|uking/i },
  { key: 'lobster', name: 'LobsterAI', adapter: null, match: /lobster/i },
  { key: 'codebuddy', name: 'CodeBuddy', adapter: 'codebuddy', match: /codebuddy/i },
  { key: 'qoder', name: 'Qoder', adapter: 'qoder', match: /qoder/i },
  { key: 'pi', name: 'pi CLI', adapter: 'pi', match: /^\.pi$/i },
  { key: 'deepseek-tui', name: 'DeepSeek TUI', adapter: 'deepseek-tui', match: /^\.deepseek$/i },
  { key: 'magpie', name: 'Magpie', adapter: null, match: /magpie/i },
  { key: 'openclaw', name: 'OpenClaw', adapter: null, match: /openclaw|u-?claw/i },
];

function plistInfo(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return {};
  const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  if (r.status !== 0) return {};
  try {
    const d = JSON.parse(r.stdout || '{}');
    return {
      bundleId: d.CFBundleIdentifier || null,
      version: d.CFBundleShortVersionString || null,
      urlSchemes: (d.CFBundleURLTypes || []).flatMap((t) => t.CFBundleURLSchemes || []),
    };
  } catch {
    return {};
  }
}

function classifyName(name) {
  const hit = CATALOG.find((c) => c.match.test(name));
  return hit || null;
}

function mtimeIso(p) {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
}

function makeItem({ kind, base, full, info }) {
  const cat = classifyName(base) || classifyName(info.bundleId || '');
  const isAI = Boolean(cat) || AI_HINT.test(base) || AI_HINT.test(info.bundleId || '');
  if (!cat && !isAI) return null;
  return {
    kind,
    name: base,
    path: full,
    ...info,
    catalogKey: cat?.key || null,
    adapter: cat?.adapter || null,
    mtime: mtimeIso(full),
  };
}

/**
 * 扫描应用安装目录里的 app。
 *   darwin  <appDir>/Xxx.app（读 Info.plist 的 bundleId/版本）
 *   win32   Program Files / %LOCALAPPDATA%\Programs 下的目录或 .exe
 *   linux   /usr/share/applications 下的 *.desktop、/opt 下的目录
 * appDirs 可以是字符串、字符串数组，或省略（= 当前平台 scanAppDirs()）。
 */
export function scanApplications(appDirs, { platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const dirs = appDirs
    ? Array.isArray(appDirs) ? appDirs : [appDirs]
    : scanAppDirs({ platform, env, homedir });
  const out = [];
  for (const appDir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(appDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(appDir, e.name);
      let base = null;
      let info = {};
      if (platform === 'darwin') {
        if (!e.isDirectory() || !e.name.endsWith('.app')) continue;
        base = e.name.replace(/\.app$/, '');
        info = plistInfo(full);
      } else if (platform === 'win32') {
        if (e.isDirectory()) {
          base = e.name;
        } else if (e.isFile() && /\.exe$/i.test(e.name)) {
          base = e.name.replace(/\.exe$/i, '');
        } else {
          continue;
        }
      } else {
        // linux：桌面入口是 *.desktop 文件，/opt 下是目录
        if (e.isFile() && /\.desktop$/i.test(e.name)) base = e.name.replace(/\.desktop$/i, '');
        else if (e.isDirectory()) base = e.name;
        else continue;
      }
      const item = makeItem({ kind: 'app', base, full, info });
      if (item) out.push(item);
    }
  }
  // 多个安装根可能命中同一个 app（Program Files 与 (x86) 重复安装）：按 path 去重
  const seen = new Set();
  return out
    .filter((i) => (seen.has(i.path) ? false : (seen.add(i.path), true)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** 扫描家目录下的隐藏目录（AI 工具的配置/数据目录通常在这里；三平台都是点目录） */
export function scanHomeDirs({ homedir = os.homedir() } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(homedir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('.')) continue;
    if (HOME_SKIP.has(e.name)) continue;
    const cat = classifyName(e.name);
    if (!cat && !AI_HINT.test(e.name)) continue;
    const full = path.join(homedir, e.name);
    out.push({
      kind: 'dir',
      name: e.name,
      path: full,
      catalogKey: cat?.key || null,
      adapter: cat?.adapter || null,
      mtime: mtimeIso(full),
    });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * 当前平台的「应用数据根」列表 —— macOS 的 `~/Library/Application Support` 等价物。
 *   darwin  [~/Library/Application Support]
 *   win32   [%APPDATA%, %LOCALAPPDATA%]
 *   linux   [~/.config, ~/.local/share]
 */
export function scanAppDataDirs({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  return appDataRoots({ platform, env, homedir });
}

/**
 * 扫描应用数据根下命中的目录（每个 app 一个子目录）。
 * Windows 上就是扫 %APPDATA% 与 %LOCALAPPDATA%，不再只在 darwin 生效。
 */
export function scanAppSupport({ platform = process.platform, env = process.env, homedir = os.homedir(), appDataDirs } = {}) {
  const roots = appDataDirs || scanAppDataDirs({ platform, env, homedir });
  const out = [];
  const seen = new Set();
  for (const dir of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (platform === 'darwin' && e.name.startsWith('com.apple.')) continue; // 系统 agent，不是 AI 工具
      if (platform === 'win32' && WINDOWS_APPDATA_SKIP.has(e.name)) continue;
      const cat = classifyName(e.name);
      if (!cat && !AI_HINT.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({
        kind: 'support',
        name: e.name,
        path: full,
        catalogKey: cat?.key || null,
        adapter: cat?.adapter || null,
        mtime: mtimeIso(full),
      });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * 汇总发现结果，按“已支持 / 候选（AI 工具但暂无适配器）/ 待确认”分组。
 * supportedAdapterIds: 当前已注册的适配器 id 列表
 * 其余参数（platform/env/homedir/appDirs/appDataDirs）用于测试注入，正常运行不用传。
 */
export function discover({
  supportedAdapterIds = [],
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  appDirs,
  appDataDirs,
} = {}) {
  const apps = scanApplications(appDirs, { platform, env, homedir });
  const dirs = scanHomeDirs({ homedir });
  const support = scanAppSupport({ platform, env, homedir, appDataDirs });
  const supported = new Set(supportedAdapterIds);

  const items = [...apps, ...dirs, ...support].map((item) => {
    const adapters = String(item.adapter || '')
      .split(',')
      .filter(Boolean);
    const covered = adapters.some((a) => supported.has(a));
    return {
      ...item,
      adapters,
      covered,
      confidence: item.catalogKey ? 'high' : 'low',
    };
  });

  // 已支持的工具不重复列进候选（如 ~/.codex、ChatGPT.app 都归 Codex）
  const candidates = items.filter((i) => !i.covered);

  // 高置信度：命中已知 AI 产品；低置信度：只是关键词命中（可能残留在配置目录）
  const highMap = new Map();
  for (const i of candidates.filter((c) => c.confidence === 'high')) {
    const key = i.catalogKey;
    if (!highMap.has(key)) highMap.set(key, { key, name: i.name, items: [], version: null, adapter: i.adapter });
    const g = highMap.get(key);
    g.items.push(i);
    if (i.version && !g.version) g.version = i.version;
  }
  const high = [...highMap.values()]
    .map((g) => ({
      key: g.key,
      name: KEY_NAMES[g.key] || g.name,
      version: g.version,
      adapter: g.adapter,
      paths: g.items.map((i) => i.path),
      kinds: g.items.map((i) => i.kind),
      lastTouched: g.items.map((i) => i.mtime).filter(Boolean).sort().pop() || null,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));

  const low = candidates
    .filter((c) => c.confidence === 'low')
    .map((c) => ({ name: c.name, path: c.path, lastTouched: c.mtime }))
    .sort((a, b) => String(b.lastTouched || '').localeCompare(String(a.lastTouched || '')));

  return {
    generatedAt: new Date().toISOString(),
    device: os.hostname(),
    platform,
    groups: { candidate: high, lowConfidence: low },
    totals: {
      found: items.length,
      supported: items.filter((i) => i.covered).length,
      candidate: high.length,
      lowConfidence: low.length,
    },
  };
}

const KEY_NAMES = {
  dsh: 'DSH',
  codex: 'Codex / ChatGPT',
  claude: 'Claude Code / 桌面版',
  trae: 'Trae',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  workbuddy: 'WorkBuddy',
  doubaowork: '豆包·工作',
  doubao: '豆包（聊天版）',
  qoder: 'Qoder',
  uking: 'U-King',
  pi: 'pi CLI',
  'deepseek-tui': 'DeepSeek TUI',
  deepseek: 'DeepSeek（其它）',
  atlas: 'ChatGPT Atlas（浏览器）',
  comet: 'Comet（浏览器）',
  gemini: 'Gemini CLI',
  hermes: 'Hermes',
  kimi: 'Kimi',
  qwen: 'Qwen / 通义',
  lobster: 'LobsterAI',
  codebuddy: 'CodeBuddy',
  magpie: 'Magpie',
  openclaw: 'OpenClaw / U-Claw',
};
function groupName(key) {
  return KEY_NAMES[key] || key;
}
