/**
 * Model-callable tools: `workspace_hub_list` and `workspace_hub_sync`.
 *
 * Both tools return structured canonical values (so Code Mode can program
 * against them) and render compact Chinese text (so a plain chat reads well).
 * Every value is a pure projection of the ledger read and the registry state,
 * which keeps the rendered result replayable from the session log.
 * @module dsh-plugin-workspace-hub/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { LEDGER_STATES } from './ledger.js';
import { SKIP_REASONS } from './plan.js';
import { formatListText, formatSyncText } from './format.js';
const STATE_ENUM = ['in-dsh', 'candidate', 'skipped'];
/**
 * Build the two tool definitions bound to one service instance.
 * @param hub the owning workspace-hub service
 * @returns registry-ready tool definitions, list first
 */
export function createWorkspaceHubTools(hub) {
    const listTool = defineTool({
        name: 'workspace_hub_list',
        description: '列出 wshub 账本里的工作目录，并标出哪些已在 DSH 左侧工作区、哪些可同步、哪些被跳过（kind 非 project、目录已删、重复路径等）。只读，不修改任何工作区。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ledgerPath: { type: 'string', required: true },
                    ledgerState: { type: 'string', required: true, enum: LEDGER_STATES },
                    ledgerMessage: { type: 'string' },
                    ledgerUpdatedAt: { type: 'string' },
                    total: { type: 'integer', required: true },
                    inDsh: { type: 'integer', required: true },
                    candidates: { type: 'integer', required: true },
                    skipped: { type: 'integer', required: true },
                    registryTotal: { type: 'integer', required: true },
                    maxAdd: { type: 'integer', required: true },
                    dryRun: { type: 'boolean', required: true },
                    lastSyncAt: { type: 'string' },
                    entries: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                kind: { type: 'string', required: true },
                                pinned: { type: 'boolean', required: true },
                                lastActiveAt: { type: 'string' },
                                presentIn: { type: 'array', required: true, items: { type: 'string' } },
                                state: { type: 'string', required: true, enum: STATE_ENUM },
                                reason: { type: 'string', enum: SKIP_REASONS },
                                message: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: formatListText(value) }],
        },
        async execute() {
            return await hub.inspect();
        },
        presentCall: () => ({ card: 'generic', title: '列出工作目录账本', kind: 'read' }),
        isConcurrencySafe: () => true,
    });
    const syncTool = defineTool({
        name: 'workspace_hub_sync',
        description: '把 wshub 账本里「DSH 没有、kind=project、目录仍存在」的工作目录同步进 DSH 左侧工作区。幂等：按 realpath 去重，DSH 已有的不会重复创建；单次最多新增 maxAdd 个（0=不限）。dryRun=true 只演练不写入。返回新增/跳过/失败明细。',
        parameters: {
            dryRun: { type: 'boolean', description: '只演练、不写入 DSH 工作区注册表；覆盖插件配置里的 dryRun' },
            maxAdd: { type: 'integer', description: '本次最多新增多少个；0 表示不限制；缺省用插件配置' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    dryRun: { type: 'boolean', required: true },
                    startedAt: { type: 'string', required: true },
                    durationMs: { type: 'integer', required: true },
                    ledgerPath: { type: 'string', required: true },
                    ledgerState: { type: 'string', required: true, enum: LEDGER_STATES },
                    ledgerMessage: { type: 'string' },
                    ledgerUpdatedAt: { type: 'string' },
                    total: { type: 'integer', required: true },
                    alreadyPresent: { type: 'integer', required: true },
                    added: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                workspaceId: { type: 'string' },
                            },
                        },
                    },
                    skipped: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                title: { type: 'string' },
                                reason: { type: 'string', required: true, enum: SKIP_REASONS },
                                message: { type: 'string', required: true },
                            },
                        },
                    },
                    failed: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                title: { type: 'string', required: true },
                                error: { type: 'string', required: true },
                            },
                        },
                    },
                    aborted: { type: 'boolean', required: true },
                    registryTotal: { type: 'integer', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: formatSyncText(value) }],
        },
        async execute(args, exec) {
            return await hub.sync({
                ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
                ...(args.maxAdd !== undefined ? { maxAdd: args.maxAdd } : {}),
                trigger: 'tool',
                signal: exec.signal,
            });
        },
        presentCall: (args) => ({
            card: 'generic',
            title: args.dryRun === true ? '演练：同步工作目录到 DSH 侧栏' : '同步工作目录到 DSH 侧栏',
        }),
    });
    const refreshTool = defineTool({
        name: 'workspace_hub_refresh',
        description: '先运行一次 wshub scan（刷新账本，采集各 AI 工具最新工作目录），再把账本同步进 DSH 左侧工作区。用于「刚在 WorkBuddy / Trae / Codex 等工具新建了项目，想让它马上出现在 DSH」。扫描失败不影响同步，会原样报告。',
        parameters: {
            dryRun: { type: 'boolean', description: '只演练同步、不写入 DSH 工作区；扫描仍会执行' },
            maxAdd: { type: 'integer', description: '本次最多新增多少个；0 表示不限制；缺省用插件配置' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    scan: {
                        type: 'object',
                        required: true,
                        additionalProperties: false,
                        properties: {
                            ok: { type: 'boolean', required: true },
                            skipped: { type: 'boolean', required: true },
                            message: { type: 'string' },
                        },
                    },
                    dryRun: { type: 'boolean', required: true },
                    ledgerState: { type: 'string', required: true, enum: LEDGER_STATES },
                    total: { type: 'integer', required: true },
                    alreadyPresent: { type: 'integer', required: true },
                    addedCount: { type: 'integer', required: true },
                    skippedCount: { type: 'integer', required: true },
                    failedCount: { type: 'integer', required: true },
                    registryTotal: { type: 'integer', required: true },
                },
            },
            render: (_args, value) => {
                const scanText = value.scan.ok
                    ? '扫描：成功'
                    : value.scan.skipped
                        ? '扫描：跳过（' + (value.scan.message ?? '未找到 wshub CLI') + '）'
                        : '扫描：失败（' + (value.scan.message ?? '未知错误') + '）';
                const mode = value.dryRun ? '演练（未写入）' : '已写入';
                return [
                    {
                        type: 'text',
                        text: '刷新 + 同步结果（' + mode + '）\n' +
                            scanText +
                            '\n新增 ' + value.addedCount +
                            ' ｜ 已存在 ' + value.alreadyPresent +
                            ' ｜ 跳过 ' + value.skippedCount +
                            ' ｜ 失败 ' + value.failedCount +
                            ' ｜ 账本 ' + value.total +
                            ' ｜ DSH 现有 ' + value.registryTotal,
                    },
                ];
            },
        },
        async execute(args, exec) {
            const { scan, sync } = await hub.refresh({
                ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
                ...(args.maxAdd !== undefined ? { maxAdd: args.maxAdd } : {}),
                trigger: 'tool',
                signal: exec.signal,
            });
            return {
                scan: {
                    ok: scan.ok,
                    skipped: scan.skipped,
                    ...(scan.message !== undefined ? { message: scan.message } : {}),
                },
                dryRun: sync.dryRun,
                ledgerState: sync.ledgerState,
                ...(sync.ledgerMessage !== undefined ? { ledgerMessage: sync.ledgerMessage } : {}),
                total: sync.total,
                alreadyPresent: sync.alreadyPresent,
                addedCount: sync.added.length,
                skippedCount: sync.skipped.length,
                failedCount: sync.failed.length,
                registryTotal: sync.registryTotal,
            };
        },
        presentCall: (args) => ({
            card: 'generic',
            title: args.dryRun === true ? '演练：刷新并同步工作目录' : '刷新并同步工作目录',
        }),
    });
    const remoteSyncTool = defineTool({
        name: 'workspace_hub_remote_sync',
        description: '用 GitHub 私有仓做跨设备账本同步：拉取远端账本 → 扫描本机各 AI 工具 → 推送变更 → 再把账本同步进 DSH 左侧工作区。需要先在插件配置里填 gitRepo。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    gitRepo: { type: 'string' },
                    pullOk: { type: 'boolean' },
                    pushOk: { type: 'boolean' },
                    scanOk: { type: 'boolean' },
                    workspaces: { type: 'integer' },
                    addedCount: { type: 'integer', required: true },
                    alreadyPresent: { type: 'integer', required: true },
                    skippedCount: { type: 'integer', required: true },
                    failedCount: { type: 'integer', required: true },
                    registryTotal: { type: 'integer', required: true },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const lines = ['GitHub 账本同步' + (value.ok ? '成功' : '失败')];
                if (value.gitRepo)
                    lines.push('仓库：' + value.gitRepo);
                lines.push('拉取 ' + (value.pullOk ? '成功' : '失败') +
                    ' ｜ 扫描 ' + (value.scanOk ? '成功' : '失败') +
                    ' ｜ 推送 ' + (value.pushOk ? '成功' : '失败'));
                lines.push('账本 ' + (value.workspaces ?? '?') + ' 条 ｜ 新增 ' + value.addedCount +
                    ' ｜ 已存在 ' + value.alreadyPresent + ' ｜ 跳过 ' + value.skippedCount +
                    ' ｜ 失败 ' + value.failedCount + ' ｜ DSH 现有 ' + value.registryTotal);
                if (value.error)
                    lines.push('错误：' + value.error);
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute() {
            const auto = await hub.autoSync();
            const sync = await hub.sync({ trigger: 'tool' });
            return {
                ok: auto.ok && sync.failed.length === 0,
                ...(auto.steps?.repo ? { gitRepo: auto.steps.repo } : {}),
                pullOk: auto.steps?.pull?.ok === true,
                pushOk: auto.steps?.push?.ok === true,
                scanOk: auto.steps?.scan?.ok === true,
                ...(typeof auto.steps?.pull?.workspaces === 'number' ? { workspaces: auto.steps.pull.workspaces } : {}),
                addedCount: sync.added.length,
                alreadyPresent: sync.alreadyPresent,
                skippedCount: sync.skipped.length,
                failedCount: sync.failed.length,
                registryTotal: sync.registryTotal,
                ...(auto.error ? { error: auto.error } : {}),
            };
        },
        presentCall: () => ({ card: 'generic', title: 'GitHub 账本同步' }),
    });
    return [listTool, syncTool, refreshTool, remoteSyncTool];
}
