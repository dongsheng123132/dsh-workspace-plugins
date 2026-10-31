/**
 * Read-only access to the wshub ledger (`$WSHUB_HOME/ledger.json`).
 *
 * The ledger is the wshub CLI's union truth source: every workspace that any
 * supported AI tool has shown on its left sidebar, merged by
 * `hub/lib/ledger.mjs`. This module never writes it — the DSH plugin only
 * consumes the ledger so that two writers can never fight over one file.
 * @module dsh-plugin-workspace-hub/ledger
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Every read outcome, in declaration order; the model-facing Schema reuses this list. */
export const LEDGER_STATES = ['ok', 'missing', 'invalid-json', 'invalid-shape', 'read-error'] as const

/** Outcome of reading the ledger file; every non-`ok` state is reported, never thrown. */
export type LedgerState = (typeof LEDGER_STATES)[number]

/**
 * One raw ledger workspace record.
 *
 * Only the fields this plugin consumes are typed. Everything stays optional:
 * the file belongs to another tool, so an older or newer schema must degrade
 * into a reported skip instead of crashing the Host.
 */
export interface LedgerEntry {
  readonly path?: unknown
  readonly displayName?: unknown
  readonly kind?: unknown
  readonly pinned?: unknown
  readonly lastActiveAt?: unknown
  readonly presentIn?: unknown
}

/** Paths the user removed from the DSH sidebar via `wshub dsh-prune`; never re-seed these. */
async function readExclude(ledgerPath: string): Promise<ReadonlySet<string>> {
  const file = path.join(path.dirname(ledgerPath), 'exclude.json')
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(raw)) return new Set()
    return new Set(
      raw
        .filter((x): x is string => typeof x === 'string')
        .map((x) => path.resolve(expandHomePath(x)).replace(/[\\/]+$/, ''))
        .map((x) => (process.platform === 'win32' ? x.toLowerCase() : x)),
    )
  } catch {
    return new Set()
  }
}

/** One read of the ledger, including the failure state the model will see. */
export interface LedgerSnapshot {
  /** Absolute path the plugin tried to read. */
  readonly ledgerPath: string
  /** Parse/read outcome. */
  readonly state: LedgerState
  /** Actionable explanation for a non-`ok` state; absent when `ok`. */
  readonly message?: string
  /** Ledger's own `updatedAt`, when it carries a string. */
  readonly updatedAt?: string
  /** Raw workspace records in ledger order; empty unless `state === 'ok'`. */
  readonly entries: LedgerEntry[]
}

/** A directory that exists or not, or a filesystem call that failed for a deeper reason. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${error.message} (${code})` : error.message
  }
  return String(error)
}

/** Expand a leading `~` or `~/` without resolving symlinks. */
export function expandHomePath(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2))
  return input
}

/**
 * Default ledger location, mirroring the wshub CLI's own resolution order:
 * `$WSHUB_HOME/ledger.json`, then `$WDHUB_HOME/ledger.json`, then
 * `~/.workspace-hub/ledger.json`.
 * @returns absolute ledger path
 */
export function defaultLedgerPath(): string {
  const home = process.env['WSHUB_HOME'] ?? process.env['WDHUB_HOME']
  if (home !== undefined && home !== '') return path.join(path.resolve(expandHomePath(home)), 'ledger.json')
  return path.join(homedir(), '.workspace-hub', 'ledger.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read and shape-check the ledger file. Never throws for a missing or broken
 * ledger: the Host must stay usable, so the failure is returned as data and
 * surfaced by `workspace_hub_list` / `workspace_hub_sync`.
 * @param ledgerPath absolute or `~`-prefixed ledger path
 * @returns the snapshot including its state
 */
export async function readLedger(ledgerPath: string): Promise<LedgerSnapshot> {
  const absolute = path.resolve(expandHomePath(ledgerPath))
  const empty = { ledgerPath: absolute, entries: [] as LedgerEntry[] }

  let text: string
  try {
    text = await readFile(absolute, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        ...empty,
        state: 'missing',
        message: `账本不存在：${absolute}。先跑一次 \`node hub/wdhub.mjs scan --save\`（或 wshub scan --save）生成账本。`,
      }
    }
    return { ...empty, state: 'read-error', message: `读取账本失败：${describeError(error)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ...empty, state: 'invalid-json', message: `账本不是合法 JSON：${describeError(error)}` }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['workspaces'])) {
    return {
      ...empty,
      state: 'invalid-shape',
      message: '账本结构不符：期望对象且带 workspaces 数组（见 hub/lib/ledger.mjs 的 schema）。',
    }
  }

  const entries: LedgerEntry[] = []
  const exclude = await readExclude(absolute)
  for (const item of parsed['workspaces']) {
    // dsh-prune 清理掉的路径不再补回；其余非对象条目保留为空记录，交给 planner 报 skip。
    if (isRecord(item) && typeof item['path'] === 'string') {
      const norm = path.resolve(item['path']).replace(/[\\/]+$/, '')
      if (exclude.has(process.platform === 'win32' ? norm.toLowerCase() : norm)) continue
    }
    entries.push(isRecord(item) ? (item as LedgerEntry) : {})
  }
  const updatedAt = parsed['updatedAt']
  return {
    ledgerPath: absolute,
    state: 'ok',
    entries,
    ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
  }
}
