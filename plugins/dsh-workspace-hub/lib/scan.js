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
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const TAIL_BYTES = 2000;
function tail(value) {
    return value.length > TAIL_BYTES ? value.slice(-TAIL_BYTES) : value;
}
/**
 * Prefer the CLI shipped in this npm package; retain the old checkout path
 * as a fallback for development checkouts without the vendored source.
 * @returns absolute candidate path (existence is checked by the caller)
 */
export function defaultHubCliPath() {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const pluginRoot = path.resolve(here, '..');
    const bundled = path.join(pluginRoot, 'hub', 'wdhub.mjs');
    if (existsSync(bundled))
        return bundled;
    const legacy = path.resolve(pluginRoot, '..', '..', 'hub', 'wdhub.mjs');
    return existsSync(legacy) ? legacy : bundled;
}
/**
 * Run `wshub scan --save --home <ledger dir>` with a hard timeout.
 * Never throws: every failure becomes a {@link ScanResult}.
 * @param options CLI path, ledger path, and timeout
 * @returns the scan outcome
 */
export async function runHubScan(options) {
    const cli = options.cliPath;
    if (!cli || !existsSync(cli)) {
        return { ok: false, skipped: true, message: `未找到 wshub CLI：${cli || '(未配置)'}；跳过扫描，只读现有账本` };
    }
    const home = path.dirname(options.ledgerPath);
    return await new Promise((resolve) => {
        execFile(process.execPath, [cli, 'scan', '--save', '--home', home], {
            timeout: options.timeoutMs,
            env: { ...process.env, WSHUB_HOME: home },
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            const out = String(stdout ?? '');
            const err = String(stderr ?? '');
            if (error) {
                const code = error.code;
                resolve({
                    ok: false,
                    skipped: false,
                    ...(typeof code === 'number' ? { exitCode: code } : {}),
                    message: error.message,
                    stdoutTail: tail(out),
                    stderrTail: tail(err),
                });
                return;
            }
            resolve({ ok: true, skipped: false, exitCode: 0, stdoutTail: tail(out), stderrTail: tail(err) });
        });
    });
}
/** Run any `wshub` subcommand with a timeout; never throws. */
export async function runHubCommand(options) {
    const cli = options.cliPath;
    if (!cli || !existsSync(cli)) {
        return { ok: false, skipped: true, message: `未找到 wshub CLI：${cli || '(未配置)'}；跳过`, stdout: '' };
    }
    return await new Promise((resolve) => {
        execFile(process.execPath, [cli, ...options.args], { timeout: options.timeoutMs, env: { ...process.env }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            const out = String(stdout ?? '');
            const err = String(stderr ?? '');
            if (error) {
                const code = error.code;
                resolve({
                    ok: false,
                    skipped: false,
                    ...(typeof code === 'number' ? { exitCode: code } : {}),
                    message: error.message,
                    stdout: out,
                    stdoutTail: tail(out),
                    stderrTail: tail(err),
                });
                return;
            }
            resolve({ ok: true, skipped: false, exitCode: 0, stdout: out, stdoutTail: tail(out), stderrTail: tail(err) });
        });
    });
}
