/**
 * Chinese-friendly, replayable projections of the sync plan and sync result.
 *
 * These functions are pure: they depend only on their argument values, so the
 * same text can be rebuilt from the session log during replay.
 * @module dsh-plugin-workspace-hub/format
 */
import type { LedgerState } from './ledger.js'
import { SKIP_REASON_TEXT, type SkipReason, type SyncPlan } from './plan.js'
import type { SyncResult } from './sync.js'

/** How one ledger record currently relates to the DSH workspace list. */
export type EntryState = 'in-dsh' | 'candidate' | 'skipped'

/** One model-visible ledger row of `workspace_hub_list`. */
export interface ListEntryView {
  readonly path: string
  readonly title: string
  readonly kind: string
  readonly pinned: boolean
  readonly lastActiveAt?: string
  readonly presentIn: string[]
  readonly state: EntryState
  readonly reason?: SkipReason
  readonly message?: string
}

/** Canonical value of the `workspace_hub_list` tool. */
export interface ListView {
  readonly ledgerPath: string
  readonly ledgerState: LedgerState
  readonly ledgerMessage?: string
  readonly ledgerUpdatedAt?: string
  readonly total: number
  readonly inDsh: number
  readonly candidates: number
  readonly skipped: number
  readonly registryTotal: number
  readonly maxAdd: number
  readonly dryRun: boolean
  readonly lastSyncAt?: string
  readonly entries: ListEntryView[]
}

/** Everything the list projection needs beyond the plan itself. */
export interface ListViewExtras {
  readonly registryTotal: number
  readonly maxAdd: number
  readonly dryRun: boolean
  readonly lastSyncAt?: string
}

/**
 * Join a plan with live registry facts into the model-visible list value.
 * @param plan plan built from the current ledger
 * @param extras registry size, effective config, and last sync instant
 * @returns the canonical list view
 */
export function buildListView(plan: SyncPlan, extras: ListViewExtras): ListView {
  const entries: ListEntryView[] = []
  for (const candidate of plan.candidates) {
    entries.push({
      path: candidate.path,
      title: candidate.title,
      kind: candidate.kind,
      pinned: candidate.pinned,
      ...(candidate.lastActiveAt !== undefined ? { lastActiveAt: candidate.lastActiveAt } : {}),
      presentIn: candidate.presentIn,
      state: 'candidate',
    })
  }
  for (const present of plan.present) {
    entries.push({
      path: present.path,
      title: present.title,
      kind: 'project',
      pinned: false,
      presentIn: [],
      state: 'in-dsh',
    })
  }
  for (const skipped of plan.skipped) {
    entries.push({
      path: skipped.path,
      title: skipped.title ?? skipped.path,
      kind: 'project',
      pinned: false,
      presentIn: [],
      state: 'skipped',
      reason: skipped.reason,
      message: skipped.message,
    })
  }
  return {
    ledgerPath: plan.ledgerPath,
    ledgerState: plan.ledgerState,
    ...(plan.ledgerMessage !== undefined ? { ledgerMessage: plan.ledgerMessage } : {}),
    ...(plan.ledgerUpdatedAt !== undefined ? { ledgerUpdatedAt: plan.ledgerUpdatedAt } : {}),
    total: plan.total,
    inDsh: plan.alreadyPresent,
    candidates: plan.candidates.length,
    skipped: plan.skipped.length,
    registryTotal: extras.registryTotal,
    maxAdd: extras.maxAdd,
    dryRun: extras.dryRun,
    ...(extras.lastSyncAt !== undefined ? { lastSyncAt: extras.lastSyncAt } : {}),
    entries,
  }
}

function ledgerStateText(view: { readonly ledgerState: LedgerState; readonly ledgerUpdatedAt?: string }): string {
  const updated = view.ledgerUpdatedAt !== undefined ? `，更新于 ${view.ledgerUpdatedAt}` : ''
  return `${view.ledgerState}${updated}`
}

function describeTools(presentIn: string[]): string {
  return presentIn.length > 0 ? `（${presentIn.join('、')}）` : ''
}

/**
 * Render the list value as compact Chinese text: counts first, then one line
 * per ledger record grouped by state.
 * @param view the canonical list value
 * @returns model-visible text
 */
export function formatListText(view: ListView): string {
  const lines: string[] = ['DSH 工作区账本总览', `账本：${view.ledgerPath}`]
  if (view.ledgerState !== 'ok') {
    lines.push(`状态：${view.ledgerState}`)
    if (view.ledgerMessage !== undefined) lines.push(`原因：${view.ledgerMessage}`)
    lines.push(`DSH 当前工作区：${view.registryTotal} 个`)
    return lines.join('\n')
  }
  lines.push(`状态：${ledgerStateText(view)}`)
  lines.push(
    `账本条目：${view.total} ｜ 已在 DSH：${view.inDsh} ｜ 可同步：${view.candidates} ｜ 跳过：${view.skipped}`,
  )
  lines.push(
    `DSH 当前工作区：${view.registryTotal} 个 ｜ 单次上限 maxAdd：${view.maxAdd} ｜ 演练模式：${view.dryRun ? '是' : '否'}`,
  )
  if (view.lastSyncAt !== undefined) lines.push(`上次同步：${view.lastSyncAt}`)
  if (view.entries.length === 0) {
    lines.push('账本是空的。先跑一次 `node hub/wdhub.mjs scan --save` 生成账本，再调用 workspace_hub_sync。')
    return lines.join('\n')
  }
  lines.push('', '条目：')
  for (const entry of view.entries) {
    const label = entry.title !== '' ? entry.title : entry.path
    if (entry.state === 'candidate') {
      lines.push(`- [可同步] ${label}  ${entry.path}${describeTools(entry.presentIn)}`)
      continue
    }
    if (entry.state === 'in-dsh') {
      lines.push(`- [已在 DSH] ${label}  ${entry.path}`)
      continue
    }
    lines.push(`- [跳过：${entry.message ?? SKIP_REASON_TEXT[entry.reason ?? 'invalid-entry']}] ${label}  ${entry.path}`)
  }
  lines.push('', '提示：调用 workspace_hub_sync 把「可同步」条目加进 DSH 左侧工作区；先演练可传 dryRun=true。')
  return lines.join('\n')
}
function addedLine(entry: SyncResult['added'][number], index: number): string {
  return `${index + 1}. ${entry.title}  ${entry.path}`
}

/**
 * Render a sync result as Chinese text: what was created, what was already
 * there, what was skipped and what failed.
 * @param result the canonical sync result value
 * @returns model-visible text
 */
export function formatSyncText(result: SyncResult): string {
  const title = result.dryRun ? 'DSH 工作区同步演练（未写入）' : 'DSH 工作区同步结果'
  const lines: string[] = [`${title}（${result.startedAt}，耗时 ${result.durationMs}ms）`]
  lines.push(`账本：${result.ledgerPath} ｜ 状态：${ledgerStateText(result)}`)
  if (result.ledgerState !== 'ok' && result.ledgerMessage !== undefined) {
    lines.push(`原因：${result.ledgerMessage}`)
  }
  lines.push(
    `新增：${result.added.length} ｜ 已在 DSH：${result.alreadyPresent} ｜ 跳过：${result.skipped.length} ｜ 失败：${result.failed.length} ｜ 已中断：${result.aborted ? '是' : '否'}`,
  )
  lines.push(`DSH 当前工作区：${result.registryTotal} 个`)

  if (result.added.length > 0) {
    lines.push('', result.dryRun ? '将新增（按侧栏从上到下）：' : '新增（按侧栏从上到下）：')
    for (let index = 0; index < result.added.length; index += 1) {
      const entry = result.added[index]
      if (entry !== undefined) lines.push(addedLine(entry, index))
    }
  } else if (result.ledgerState === 'ok') {
    lines.push('', '本次没有需要新增的工作区：账本里的项目都已在 DSH 中，或被下面的原因跳过。')
  }

  if (result.skipped.length > 0) {
    lines.push('', '跳过：')
    for (const entry of result.skipped) {
      const label = entry.title ?? entry.path
      lines.push(`- [${entry.message}] ${label}  ${entry.path}`)
    }
  }
  if (result.failed.length > 0) {
    lines.push('', '失败（可在修复目录/权限后重试）：')
    for (const entry of result.failed) lines.push(`- ${entry.title}  ${entry.path}：${entry.error}`)
  }
  return lines.join('\n')
}
