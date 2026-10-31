/**
 * Optional pre-sync scan: run the local wshub CLI (`hub/wdhub.mjs scan --save`)
 * so the ledger is fresh before the plugin reconciles it into the DSH sidebar.
 *
 * Why this exists: the plugin only reads `ledger.json`; a project created in
 * WorkBuddy / Trae / Codex after the last scan is invisible until someone runs
 * `wshub scan --save`. With `scanOnStart` the activation pass scans first.
 * Failures never fail plugin activation — the plugin falls back to the current
 * ledger file and reports the scan problem through logs/tools.
 * @module dsh-plugin-workspace-hub/scan
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Outcome of one best-effort scan attempt. */
export interface ScanResult {
  /** `true` only when the CLI exited 0. */
  readonly ok: boolean
  /** `true` when no usable CLI was found; activation continues with the current ledger. */
  readonly skipped: boolean
  /** CLI exit code when it ran and failed. */
  readonly exitCode?: number
  /** Human-readable detail (Chinese); present on skip/failure. */
  readonly message?: string
  /** Last ~2KB of stdout, for diagnostics. */
  readonly stdoutTail?: string
  /** Last ~2KB of stderr, for diagnostics. */
  readonly stderrTail?: string
}

const TAIL_BYTES = 2000

function tail(value: string): string {
  return value.length > TAIL_BYTES ? value.slice(-TAIL_BYTES) : value
}

/**
 * Prefer the CLI shipped in this npm package; retain the old checkout path
 * as a fallback for development checkouts without the vendored source.
 * @returns absolute candidate path (existence is checked by the caller)
 */
export function defaultHubCliPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const pluginRoot = path.resolve(here, '..')
  const bundled = path.join(pluginRoot, 'hub', 'wdhub.mjs')
  if (existsSync(bundled)) return bundled
  const legacy = path.resolve(pluginRoot, '..', '..', 'hub', 'wdhub.mjs')
  return existsSync(legacy) ? legacy : bundled
}

/** Inputs for {@link runHubScan}. */
export interface ScanOptions {
  readonly cliPath: string
  readonly ledgerPath: string
  readonly timeoutMs: number
}

/**
 * Run `wshub scan --save --home <ledger dir>` with a hard timeout.
 * Never throws: every failure becomes a {@link ScanResult}.
 * @param options CLI path, ledger path, and timeout
 * @returns the scan outcome
 */
export async function runHubScan(options: ScanOptions): Promise<ScanResult> {
  const cli = options.cliPath
  if (!cli || !existsSync(cli)) {
    return { ok: false, skipped: true, message: `未找到 wshub CLI：${cli || '(未配置)'}；跳过扫描，只读现有账本` }
  }
  const home = path.dirname(options.ledgerPath)
  return await new Promise<ScanResult>((resolve) => {
    execFile(
      process.execPath,
      [cli, 'scan', '--save', '--home', home],
      {
        timeout: options.timeoutMs,
        env: { ...process.env, WSHUB_HOME: home },
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        const err = String(stderr ?? '')
        if (error) {
          const code = (error as { code?: unknown }).code
          resolve({
            ok: false,
            skipped: false,
            ...(typeof code === 'number' ? { exitCode: code } : {}),
            message: error.message,
            stdoutTail: tail(out),
            stderrTail: tail(err),
          })
          return
        }
        resolve({ ok: true, skipped: false, exitCode: 0, stdoutTail: tail(out), stderrTail: tail(err) })
      },
    )
  })
}

/** Inputs for {@link runHubCommand}. */
export interface CommandOptions {
  readonly cliPath: string
  readonly args: string[]
  readonly timeoutMs: number
}

/** Run any `wshub` subcommand with a timeout; never throws. */
export async function runHubCommand(options: CommandOptions): Promise<ScanResult & { stdout: string }> {
  const cli = options.cliPath
  if (!cli || !existsSync(cli)) {
    return { ok: false, skipped: true, message: `未找到 wshub CLI：${cli || '(未配置)'}；跳过`, stdout: '' }
  }
  return await new Promise<ScanResult & { stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [cli, ...options.args],
      { timeout: options.timeoutMs, env: { ...process.env }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        const err = String(stderr ?? '')
        if (error) {
          const code = (error as { code?: unknown }).code
          resolve({
            ok: false,
            skipped: false,
            ...(typeof code === 'number' ? { exitCode: code } : {}),
            message: error.message,
            stdout: out,
            stdoutTail: tail(out),
            stderrTail: tail(err),
          })
          return
        }
        resolve({ ok: true, skipped: false, exitCode: 0, stdout: out, stdoutTail: tail(out), stderrTail: tail(err) })
      },
    )
  })
}
