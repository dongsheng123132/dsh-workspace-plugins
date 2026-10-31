/**
 * 读取第三方 app 的 SQLite 状态库。
 *
 * 两条通道：
 *   1. node:sqlite（Node 22.5+，实验特性）
 *   2. 系统 sqlite3 CLI（macOS/Linux 自带）
 * 共同前提：**先复制到 /tmp 再读**。app 运行中库被锁，直接读会得到 SQLITE_BUSY 或脏数据；
 * 复制时连 -wal/-shm 一起带走，否则会漏掉最近的写入。
 */
import { spawnSync } from 'node:child_process';
import { copySqliteToTemp } from './safety.mjs';

export async function querySqlite(dbFile, sql, params = []) {
  const { dbFile: tmp, cleanup } = copySqliteToTemp(dbFile);
  try {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(tmp);
      try {
        const stmt = db.prepare(sql);
        const rows = params.length ? stmt.all(...params) : stmt.all();
        return { ok: true, rows: rows || [] };
      } finally {
        db.close();
      }
    } catch (nodeSqliteErr) {
      // 只有无参数查询才走 CLI 通道，避免拼接 SQL
      if (params.length) {
        return { ok: false, error: 'node:sqlite 不可用且带参数，拒绝拼接 SQL：' + String(nodeSqliteErr?.message || nodeSqliteErr) };
      }
      const r = spawnSync('sqlite3', ['-json', tmp, sql], { encoding: 'utf8' });
      if (r.error) return { ok: false, error: String(r.error.message || r.error) };
      if (r.status !== 0) return { ok: false, error: String(r.stderr || '').trim() || 'sqlite3-failed' };
      try {
        return { ok: true, rows: JSON.parse(r.stdout || '[]') };
      } catch (e) {
        return { ok: false, error: 'sqlite3-json-parse: ' + String(e.message || e) };
      }
    }
  } finally {
    cleanup();
  }
}
