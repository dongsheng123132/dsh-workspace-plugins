/**
 * Configuration schema for dsh-plugin-workspace-hub.
 *
 * Every tunable value is a `Config` field settable from the profile's
 * `cordis.patch.yml`; invalid values fail plugin loading during Schema
 * validation instead of being silently coerced.
 * @module dsh-plugin-workspace-hub/config
 */
import Schema from '@deepseek-ai/schemastery'
import path from 'node:path'
import { defaultLedgerPath, expandHomePath } from './ledger.js'

/** User-settable configuration (validated by the Loader before `apply` runs). */
export interface Config {
  /** Ledger JSON path; `~` is expanded. Defaults to `$WSHUB_HOME/ledger.json` or `~/.workspace-hub/ledger.json`. */
  ledgerPath: string
  /** Maximum workspaces created by one pass; `0` means unlimited. */
  maxAdd: number
  /** Plan-only mode: nothing is written to the DSH registry. */
  dryRun: boolean
  /** Background resync interval in seconds; `0` disables the timer. */
  intervalSeconds: number
  /** Run `wshub scan --save` before the activation pass, so newly created projects are picked up. */
  scanOnStart: boolean
  /** Path to `hub/wdhub.mjs`; empty string prefers the bundled CLI. */
  hubCliPath: string
  /** Hard timeout for the pre-sync scan, in milliseconds. */
  scanTimeoutMs: number
  /** GitHub (or any git) private repo used as the ledger sync remote; empty disables git sync. */
  gitRepo: string
  /** Run the git pull → scan → push pass on plugin activation. */
  gitSyncOnStart: boolean
  /** Hard timeout for the git sync pass, in milliseconds. */
  gitTimeoutMs: number
}

/** Schemastery schema exported as the plugin's `Config` (Standard Schema compatible). */
export const Config: Schema<Config> = Schema.object({
  ledgerPath: Schema.string()
    .default(defaultLedgerPath())
    .description('wshub 账本 JSON 的路径；支持 ~ 前缀。默认 $WSHUB_HOME/ledger.json，其次 $WDHUB_HOME/ledger.json，最后 ~/.workspace-hub/ledger.json'),
  maxAdd: Schema.natural()
    .default(30)
    .description('单次同步最多新增多少个 DSH 工作区；0 表示不限制。用于避免一次性灌爆侧栏'),
  dryRun: Schema.boolean()
    .default(false)
    .description('演练模式：只计算与报告，不写入 DSH 工作区注册表（激活同步与定时同步同样只报告）'),
  intervalSeconds: Schema.natural()
    .default(0)
    .description('后台自动同步间隔（秒）；0 表示只在插件激活时与模型调用 workspace_hub_sync 时同步'),
  scanOnStart: Schema.boolean()
    .default(true)
    .description('插件激活时先运行 wshub scan --save 刷新账本，再同步进 DSH；关掉则只读现有账本'),
  hubCliPath: Schema.string()
    .default('')
    .description('wshub CLI 路径（hub/wdhub.mjs）；留空优先使用包内 CLI，旧仓库路径仅作回退'),
  scanTimeoutMs: Schema.natural()
    .default(60000)
    .description('激活扫描的超时时间（毫秒）；超时只记录日志，不影响插件加载'),
  gitRepo: Schema.string()
    .default('')
    .description('GitHub 私有同步仓地址（如 https://github.com/你/workspace-hub-sync.git）；留空表示不用 git 同步'),
  gitSyncOnStart: Schema.boolean()
    .default(false)
    .description('激活时执行 git 同步：拉取远端账本 → 扫描本机 → 推送变更（需要 gitRepo）'),
  gitTimeoutMs: Schema.natural()
    .default(180000)
    .description('git 同步整轮的超时时间（毫秒）'),
})

/** Configuration after resolution: `ledgerPath` is absolute. */
export type ResolvedConfig = Config

/**
 * Resolve user configuration into the values the runtime uses.
 * Kept as an explicit step so defaults never hide inside `sync()`.
 * @param config validated user configuration
 * @returns configuration with absolute ledger path
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const ledgerPath = path.resolve(expandHomePath(config.ledgerPath))
  return { ...config, ledgerPath }
}
