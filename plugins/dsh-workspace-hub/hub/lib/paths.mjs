/**
 * 路径归一化：所有适配器读出来的目录都要过这里，才能在不同工具之间对齐。
 *
 * 为什么要归一化：
 *   - 同一目录可能被写成 `/a/b/`、`file:///a/b`、`~/a/b`、带未规范化 Unicode 的路径
 *   - macOS APFS 默认大小写不敏感（/Users/x/Foo 和 /Users/x/foo 是同一个目录）
 *   - 符号链接会让同一项目出现两个“不同”路径
 * 不归一的后果：并集里出现重复项目，侧栏里看起来像两个。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 把 `~` / `~/x` 展开成绝对路径（不解析符号链接） */
export function expandHome(input) {
  if (typeof input !== 'string') return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** file:// URI -> 本地绝对路径；普通路径原样返回 */
export function fromFileUri(input) {
  if (typeof input !== 'string') return input;
  if (!input.startsWith('file://')) return input;
  try {
    return decodeURIComponent(new URL(input).pathname);
  } catch {
    return input;
  }
}

/**
 * 规范路径：展开 ~、解码 file://、绝对化、解析符号链接（存在时）、NFC、去尾斜杠。
 * 目录不存在时保留字面路径（不能因为项目被删就丢掉历史记录）。
 */
export function canonicalPath(input) {
  if (!input || typeof input !== 'string') return null;
  let p = fromFileUri(expandHome(input.trim()));
  if (!p) return null;
  if (!path.isAbsolute(p)) p = path.resolve(os.homedir(), p);
  try {
    p = fs.realpathSync.native(p);
  } catch {
    // 路径不存在 / 无权限：保留原样
  }
  p = p.normalize('NFC');
  if (p.length > 1 && p.endsWith(path.sep)) p = p.slice(0, -1);
  return p;
}

/** 用于哈希 / 去重的 key：macOS 与 Windows 上大小写不敏感 */
export function pathKey(input) {
  const c = canonicalPath(input);
  if (!c) return null;
  return process.platform === 'darwin' || process.platform === 'win32' ? c.toLowerCase() : c;
}

/** 展示用：把 home 前缀缩成 ~ */
export function displayPath(p) {
  if (!p) return p;
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

/** 目录是否还存在（同步时不能把已删目录推给别人） */
export function existsAsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 由路径 key 派生稳定 id：同一目录在任何设备/任何工具里都是同一个 id */
export function stableId(key) {
  return 'ws_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** 项目显示名：优先工具自带标题，否则用目录名 */
export function defaultTitle(p) {
  const base = path.basename(p || '');
  return base || displayPath(p);
}
