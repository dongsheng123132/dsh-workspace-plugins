/**
 * 平台差异收敛层（macOS / Windows / Linux）。
 *
 * 为什么要单独一层：
 *   同一个 AI 工具在三个平台上的「数据落点」和「应用安装位置」完全不同，
 *   而 adapter 里一旦写死 `~/Library/Application Support/...` 或 `p.startsWith('/')`，
 *   代码在 Windows 上就静默读不到任何东西（不报错、只是 0 条，最难排查）。
 *   所有“平台相关”的判断都收在这里，adapter / discover / device 只调用这层。
 *
 * 设计要点：
 *   1. 所有函数都接受 `{ platform, env, homedir }` 注入，默认取当前进程真值。
 *      这样测试可以在 macOS 上模拟 win32 布局（临时目录 + 假环境变量），不需要真 Windows。
 *   2. 路径拼接按 **base 的写法** 选分隔符（含 `\` 或盘符 → `\`，否则 `/`）。
 *      这样注入的 Windows 风格路径永远是 Windows 风格，注入的临时目录仍然是本机可访问的 POSIX 路径。
 *   3. `isAbsoluteAnyPlatform()` 只回答“是不是绝对路径”，不改变路径本身 ——
 *      用来替换 adapter 里的 `p.startsWith('/')`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// 路径形态判断
// ---------------------------------------------------------------------------

/** `C:\x` / `C:/x` */
const WIN_DRIVE_ABS = /^[A-Za-z]:[\\/]/;
/** `\\server\share`（UNC，共享名可后跟子路径） */
const WIN_UNC_ABS = /^\\\\[^\\/]+[\\/][^\\/]*/;
/** `\\?\C:\x`、`\\.\pipe\x` 这类设备/长路径前缀 */
const WIN_DEVICE_ABS = /^\\\\[?.]\\/;

/**
 * 绝对路径判断（跨平台）。
 * 接受：`/x`、`C:\x`、`C:/x`、`\\server\share`、`\\?\C:\x`
 * 拒绝：相对路径、空串、非字符串、`C:`（盘符相对）、`\server`（无共享名）
 */
export function isAbsoluteAnyPlatform(p) {
  if (typeof p !== 'string') return false;
  const s = p.trim();
  if (!s) return false;
  if (s.startsWith('/')) return true;
  if (WIN_DRIVE_ABS.test(s)) return true;
  if (WIN_DEVICE_ABS.test(s)) return true;
  if (WIN_UNC_ABS.test(s)) return true;
  return false;
}

/** 路径写法：'win32'（盘符/UNC/反斜杠）或 'posix' */
export function pathStyleOf(p) {
  if (typeof p !== 'string' || !p) return 'posix';
  if (p.includes('\\') || /^[A-Za-z]:/.test(p)) return 'win32';
  return 'posix';
}

/** 该路径/平台习惯的分隔符 */
export function separatorFor(p) {
  return pathStyleOf(p) === 'win32' ? '\\' : '/';
}

/** 该平台的 path 模块（win32 / posix），用于纯字符串拼接，不碰本机文件系统 */
export function pathModuleFor(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * 按 base 的写法拼路径（不解析符号链接、不检查存在性）。
 * 例子：joinPath('/Users/a', 'Library', 'Application Support') → '/Users/a/Library/Application Support'
 *       joinPath('C:\\Users\\a', 'AppData')                   → 'C:\\Users\\a\\AppData'
 *       joinPath('/', 'Applications')                         → '/Applications'
 */
export function joinPath(base, ...segments) {
  if (typeof base !== 'string' || !base) return base;
  const sep = separatorFor(base);
  const rooted = /^[\\/]+$/.test(base) || /^[A-Za-z]:[\\/]$/.test(base);
  let out = rooted ? base : base.replace(/[\\/]+$/, '');
  for (const raw of segments.flat()) {
    if (raw == null || raw === '') continue;
    const seg = String(raw).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    if (!seg) continue;
    if (out && !/[\\/]$/.test(out)) out += sep;
    out += seg;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 应用数据目录（Application Support / APPDATA / .config）
// ---------------------------------------------------------------------------

function dedupe(list) {
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * 当前平台的「应用数据根目录」：adapter 的应用级数据都落在这里。
 *   darwin  ~/Library/Application Support
 *   win32   %APPDATA%（Roaming）、%LOCALAPPDATA%（Local）
 *   linux   ~/.config、~/.local/share
 */
export function appDataRoots({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const home = homedir || os.homedir();
  const e = env || {};
  if (platform === 'darwin') return [joinPath(home, 'Library', 'Application Support')];
  if (platform === 'win32') {
    const roaming = e.APPDATA || joinPath(home, 'AppData', 'Roaming');
    const local = e.LOCALAPPDATA || joinPath(home, 'AppData', 'Local');
    return dedupe([roaming, local]);
  }
  if (platform === 'linux') return dedupe([joinPath(home, '.config'), joinPath(home, '.local', 'share')]);
  return [];
}

/**
 * 某应用的候选数据目录（按优先级，不检查存在性）。
 *   darwin  ~/Library/Application Support/<App>
 *   win32   %APPDATA%\<App>、%LOCALAPPDATA%\<App>
 *   linux   ~/.config/<App>、~/.local/share/<App>
 */
export function appDataCandidates(appName, opts = {}) {
  if (appName == null) return [];
  const name = String(appName).trim();
  if (!name) return [];
  return appDataRoots(opts).map((root) => joinPath(root, name));
}

/** 返回第一个真实存在的候选目录；都不存在返回 null */
export function resolveAppDataDir(appName, opts = {}) {
  for (const dir of appDataCandidates(appName, opts)) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* 不存在或无权限：继续下一个候选 */
    }
  }
  return null;
}

/**
 * 当前平台的「应用安装扫描根」（找 .app / 安装目录 / .desktop）。
 *   darwin  /Applications
 *   win32   Program Files、Program Files (x86)、%LOCALAPPDATA%\Programs
 *   linux   /usr/share/applications、/opt
 */
export function scanAppDirs({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const e = env || {};
  const home = homedir || os.homedir();
  if (platform === 'darwin') return ['/Applications'];
  if (platform === 'win32') {
    const drive = e.SystemDrive || 'C:';
    const programFiles = e.ProgramFiles || joinPath(drive, 'Program Files');
    const programFilesX86 = e['ProgramFiles(x86)'] || joinPath(drive, 'Program Files (x86)');
    const local = e.LOCALAPPDATA || joinPath(home, 'AppData', 'Local');
    return dedupe([programFiles, programFilesX86, joinPath(local, 'Programs')]);
  }
  if (platform === 'linux') return ['/usr/share/applications', '/opt'];
  return [];
}

/** 路径 child 是否等于 parent 或位于其下（分隔符无关，大小写按平台） */
export function isUnderPath(child, parent, { platform = process.platform, caseInsensitive } = {}) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false;
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const a = norm(child);
  const b = norm(parent);
  if (!a || !b) return false;
  const ci = caseInsensitive ?? (platform === 'darwin' || platform === 'win32');
  const A = ci ? a.toLowerCase() : a;
  const B = ci ? b.toLowerCase() : b;
  return A === B || A.startsWith(B + '/');
}

// ---------------------------------------------------------------------------
// file:// URI
// ---------------------------------------------------------------------------

/**
 * file:// URI → 本机路径（比 paths.mjs 的 fromFileUri 多处理 Windows 形态）。
 *   darwin/linux  file:///tmp/x                     → /tmp/x
 *   win32         file:///C:/Users/x/proj           → C:\Users\x\proj
 *   win32         file://server/share/x             → \\server\share\x
 * 非 file:// 输入原样返回。
 */
export function fileUriToPath(uri, { platform = process.platform } = {}) {
  if (typeof uri !== 'string' || !/^file:\/\//i.test(uri)) return uri;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return uri;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(u.pathname || '');
  } catch {
    pathname = u.pathname || '';
  }
  if (platform !== 'win32') return pathname;
  // UNC：file://server/share/x
  if (u.host && u.host.toLowerCase() !== 'localhost') {
    return '\\\\' + u.host + pathname.replace(/\//g, '\\');
  }
  // 盘符：/C:/Users/x → C:\Users\x
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  return pathname.replace(/\//g, '\\');
}

// ---------------------------------------------------------------------------
// 临时目录（app 自己生成的 scratch，不该跨设备播种）
// ---------------------------------------------------------------------------

/** 是否是“临时 scratch”目录：POSIX /tmp、Windows %TEMP% */
export function isTempScratch(p, { platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (typeof p !== 'string' || !p) return false;
  if (platform !== 'win32') return /^\/(private\/)?tmp(\/|$)/.test(p);
  const e = env || {};
  const home = homedir || os.homedir();
  const tempRoots = [e.TEMP, e.TMP, joinPath(home, 'AppData', 'Local', 'Temp')].filter(Boolean);
  if (tempRoots.some((root) => isUnderPath(p, root, { platform }))) return true;
  return /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i.test(p);
}

// ---------------------------------------------------------------------------
// 进程启动 / 打开目录
// ---------------------------------------------------------------------------

/**
 * Windows 下把一条命令拼成 cmd.exe 能执行的命令行。
 * 为什么不用 shell:true：Node 只是把参数用空格拼起来，路径里有空格/`&`/`|` 就会被 cmd 拆开。
 * 这里显式给含特殊字符的参数加双引号（Windows 文件名不允许 `"`，所以转义成 `""` 足够）。
 */
export function windowsCmdLine(command, args = []) {
  const quote = (s) => {
    const str = String(s);
    if (str === '') return '""';
    if (/[\s"&|<>^()]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
  };
  return [command, ...args].map(quote).join(' ');
}

/**
 * 起一个 detached 子进程（不阻塞 CLI）。
 * `verbatim: true` 时 Windows 命令行原样传给 CreateProcess（用于 cmd.exe 组合命令）。
 */
export function spawnDetached(command, args = [], { cwd, env = process.env, platform = process.platform, verbatim = false } = {}) {
  const opts = { cwd, env, detached: true, stdio: 'ignore', windowsHide: true };
  if (platform === 'win32' && verbatim) opts.windowsVerbatimArguments = true;
  const child = spawn(command, args, opts);
  child.unref();
  return child;
}

/**
 * 在目标目录里启动一个 CLI（claude / codex / dsh / cursor ...）。
 * Windows 上这些命令通常是 `.cmd` 包装（npm 全局安装），必须经 cmd.exe 才能解析；
 * 其它平台直接 exec。
 */
export function spawnCliDetached(command, args = [], { cwd, env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') {
    return spawnDetached('cmd.exe', ['/d', '/s', '/c', windowsCmdLine(command, args)], { cwd, env, platform, verbatim: true });
  }
  return spawnDetached(command, args, { cwd, env, platform });
}

/**
 * 打开计划：在 app 里打开某个目录。纯函数（不真的启动），便于测试三种平台。
 * 返回 { command, args, verbatim, shell, how } 或 null。
 */
export function openInAppPlan(appName, target, { platform = process.platform } = {}) {
  if (!target) return null;
  const app = String(appName || '').replace(/"/g, '');
  const dest = String(target);
  if (platform === 'darwin') {
    return { command: 'open', args: ['-a', app, dest], verbatim: false, shell: false, how: `open -a ${app} ${dest}` };
  }
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `start "" ${windowsCmdLine(app, [dest])}`],
      verbatim: true,
      shell: false,
      how: `start ${app} ${dest}`,
    };
  }
  return { command: 'xdg-open', args: [dest], verbatim: false, shell: false, how: `xdg-open ${dest}` };
}

/** 打开计划：用系统默认 handler 打开一个 URL（深链接）。纯函数。 */
export function openUrlPlan(url, { platform = process.platform } = {}) {
  if (!url) return null;
  const target = String(url);
  if (platform === 'darwin') return { command: 'open', args: [target], verbatim: false, shell: false, how: target };
  if (platform === 'win32') {
    // URL 里的 `&` 会被 cmd 当成命令分隔符，必须整条包起来交给 start
    const quoted = '"' + target.replace(/"/g, '') + '"';
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" ${quoted}`], verbatim: true, shell: false, how: target };
  }
  return { command: 'xdg-open', args: [target], verbatim: false, shell: false, how: target };
}

/** 执行 open 计划；plan 为 null 时返回 null */
export function runOpenPlan(plan, { env = process.env, platform = process.platform } = {}) {
  if (!plan) return null;
  return spawnDetached(plan.command, plan.args, { env, platform, verbatim: plan.verbatim });
}

/** 在 app 里打开目录（darwin `open -a` / win32 `start` / linux `xdg-open`） */
export function openInApp(appName, target, opts = {}) {
  return runOpenPlan(openInAppPlan(appName, target, opts), opts);
}

/** 用系统默认 handler 打开 URL */
export function openExternalUrl(url, opts = {}) {
  return runOpenPlan(openUrlPlan(url, opts), opts);
}
