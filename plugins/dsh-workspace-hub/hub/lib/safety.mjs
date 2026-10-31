/**
 * 安全层：任何要写第三方 app 状态的操作，都必须经过这里。
 *
 * 设计原则（写别人家 app 的配置，坏了就是用户数据事故）：
 *   1. 先备份，再写；备份目录带时间戳，可回滚
 *   2. 原子写：临时文件 + rename，避免写一半断电留下半个 JSON
 *   3. 写前确认 app 没在运行（Electron/VS Code 会把内存里的状态回写覆盖你）
 *   4. 写完立刻读回校验
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 备份单个文件到 <backupRoot>/<时间戳>/<原名>；文件不存在返回 null */
export function backupFile(file, backupRoot, tag = '') {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupRoot, stamp + (tag ? '-' + tag : ''));
  ensureDir(dir);
  const dest = path.join(dir, path.basename(file));
  fs.copyFileSync(file, dest);
  // sqlite 的旁路文件一起备份，否则恢复后数据不一致
  for (const suffix of ['-wal', '-shm', '.backup']) {
    if (fs.existsSync(file + suffix)) {
      fs.copyFileSync(file + suffix, dest + suffix);
    }
  }
  return dest;
}

/** 原子写 JSON：tmp + rename，保留原文件权限（若存在） */
export function atomicWriteJson(file, value, { mode } = {}) {
  ensureDir(path.dirname(file));
  let finalMode = mode;
  if (finalMode == null) {
    try {
      finalMode = fs.statSync(file).mode & 0o777;
    } catch {
      finalMode = 0o644;
    }
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: finalMode });
  fs.renameSync(tmp, file);
}

/** 原子写文本（JSONL 追加不做原子，追加本身是原子的 4KB 以内） */
export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

/**
 * app 是否在运行。返回 true / false / null（探测失败）。
 * 用 pgrep 而不是 ps：macOS 上 pgrep 更轻，也不会被沙箱拦。
 */
export function isRunning(processNames = []) {
  if (!processNames.length) return null;
  const results = [];
  for (const name of processNames) {
    const r = spawnSync('pgrep', ['-x', name], { encoding: 'utf8' });
    if (r.error) return null; // pgrep 不可用
    results.push(r.status === 0);
  }
  return results.some(Boolean);
}

/** 读取 JSON，失败返回 fallback 并带上错误原因 */
export function readJson(file, fallback = null) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, value: fallback, error: err.code === 'ENOENT' ? 'not-found' : String(err.message || err) };
  }
}

/** 把 live sqlite 复制到临时目录再读：app 运行时会锁库，直接读会失败或脏读 */
export function copySqliteToTemp(dbFile) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdhub-sqlite-'));
  const dest = path.join(tmpDir, path.basename(dbFile));
  fs.copyFileSync(dbFile, dest);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, dest + suffix);
  }
  return {
    dbFile: dest,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 用完整命令行匹配进程。
 * 为什么需要它：Electron app 的主进程名常常是 "Xxx Helper" 或框架名，
 * `pgrep -x 应用名` 匹配不到。例如本机 Codex 桌面版跑在 /Applications/ChatGPT.app 里
 * （Frameworks/Codex Framework），DSH 的进程叫 "DeepSeek Harness Helper"。
 *
 * 返回 true / false / null（探测失败）。
 * 注意：返回 true 时只会让调用方更保守（不写盘），误判方向是安全的。
 */
export function isRunningByCmdline(patterns = []) {
  if (!patterns.length) return null;
  let sawError = false;
  for (const pattern of patterns) {
    const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    if (r.error) {
      sawError = true;
      continue;
    }
    if (r.status === 0) return true;
  }
  return sawError ? null : false;
}
