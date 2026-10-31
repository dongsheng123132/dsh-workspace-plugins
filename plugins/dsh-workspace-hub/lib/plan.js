/**
 * Turn ledger records into an idempotent sync plan.
 *
 * Rules (each produces a reported skip, never a silent drop):
 * - only `kind === 'project'` entries are seeded; app-managed scratch
 *   directories stay in their own tool's sidebar;
 * - only directories that currently exist are seeded (a zombie ledger entry
 *   must not create a broken DSH workspace);
 * - paths are canonicalized with `fs.realpath`, so symlinks, trailing slashes,
 *   `~` spellings and Unicode normal forms collapse to one candidate;
 * - a directory DSH already owns is reported as present, not re-created;
 * - at most `maxAdd` candidates are planned per pass (`0` = unlimited).
 * @module dsh-plugin-workspace-hub/plan
 */
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { expandHomePath } from './ledger.js';
/** Every skip reason, in declaration order; the model-facing Schema reuses this list. */
export const SKIP_REASONS = [
    'invalid-entry',
    'unsupported-kind',
    'invalid-path',
    'directory-missing',
    'duplicate-path',
    'exists-in-dsh',
    'max-add-limit',
];
/** Chinese text for every skip reason; the machine reason stays in `reason`. */
export const SKIP_REASON_TEXT = {
    'invalid-entry': '条目缺少可用的 path',
    'unsupported-kind': '不是用户项目（kind 不是 project），默认不播种',
    'invalid-path': '路径不可用（不是绝对路径或无法解析）',
    'directory-missing': '目录已不存在（僵尸条目，只提示清理）',
    'duplicate-path': '与前面的账本条目指向同一目录',
    'exists-in-dsh': 'DSH 里已经有这个工作区',
    'max-add-limit': '超过本次 maxAdd 上限，留到下次同步',
};
/** Mac/Windows filesystems compare case-insensitively; the ledger and DSH may differ in spelling. */
function comparisonKey(canonicalPath) {
    return canonicalPath.normalize('NFC');
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function titleFor(entry, canonicalPath) {
    const display = nonEmptyString(entry.displayName);
    if (display !== undefined)
        return display;
    return path.basename(canonicalPath) || canonicalPath;
}
function presentInFor(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string');
}
function skip(entry, rawPath, reason) {
    const title = nonEmptyString(entry.displayName);
    return {
        path: rawPath,
        ...(title !== undefined ? { title } : {}),
        reason,
        message: SKIP_REASON_TEXT[reason],
    };
}
/**
 * Build one plan from a ledger snapshot and the registry's current paths.
 * Pure with respect to the ledger: only filesystem reads (`stat`, `realpath`).
 * @param ledger snapshot returned by `readLedger`
 * @param options existing registry paths, per-pass cap, optional cancellation
 * @returns the plan the model and the executor both consume
 */
export async function buildSyncPlan(ledger, options) {
    const existing = new Set();
    for (const owned of options.existingPaths)
        existing.add(comparisonKey(owned));
    const limit = options.maxAdd > 0 ? options.maxAdd : Number.POSITIVE_INFINITY;
    const candidates = [];
    const present = [];
    const skipped = [];
    const seen = new Set();
    for (const entry of ledger.entries) {
        if (options.signal?.aborted === true)
            break;
        const rawPath = nonEmptyString(entry.path);
        if (rawPath === undefined) {
            skipped.push(skip(entry, '', 'invalid-entry'));
            continue;
        }
        const expanded = expandHomePath(rawPath);
        const kind = nonEmptyString(entry.kind) ?? 'project';
        if (kind !== 'project') {
            skipped.push(skip(entry, expanded, 'unsupported-kind'));
            continue;
        }
        if (!path.isAbsolute(expanded)) {
            skipped.push(skip(entry, expanded, 'invalid-path'));
            continue;
        }
        let canonicalPath;
        try {
            const info = await stat(expanded);
            if (!info.isDirectory()) {
                skipped.push(skip(entry, expanded, 'directory-missing'));
                continue;
            }
            canonicalPath = (await realpath(expanded)).normalize('NFC');
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                skipped.push(skip(entry, expanded, 'directory-missing'));
            }
            else {
                skipped.push(skip(entry, expanded, 'invalid-path'));
            }
            continue;
        }
        if (seen.has(canonicalPath)) {
            skipped.push(skip(entry, expanded, 'duplicate-path'));
            continue;
        }
        seen.add(canonicalPath);
        const title = titleFor(entry, canonicalPath);
        if (existing.has(canonicalPath)) {
            present.push({ path: expanded, canonicalPath, title });
            continue;
        }
        if (candidates.length >= limit) {
            skipped.push(skip(entry, expanded, 'max-add-limit'));
            continue;
        }
        const lastActiveAt = nonEmptyString(entry.lastActiveAt);
        candidates.push({
            path: expanded,
            canonicalPath,
            title,
            kind,
            pinned: entry.pinned === true,
            ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
            presentIn: presentInFor(entry.presentIn),
        });
    }
    const plan = {
        ledgerPath: ledger.ledgerPath,
        ledgerState: ledger.state,
        ...(ledger.message !== undefined ? { ledgerMessage: ledger.message } : {}),
        ...(ledger.updatedAt !== undefined ? { ledgerUpdatedAt: ledger.updatedAt } : {}),
        total: ledger.entries.length,
        candidates,
        present,
        skipped,
        alreadyPresent: present.length,
    };
    return plan;
}
/** Whether a canonical path is already owned by DSH; exported for tests only. */
export function isOwnedByDsh(canonicalPath, existingPaths) {
    const key = comparisonKey(canonicalPath);
    for (const owned of existingPaths)
        if (comparisonKey(owned) === key)
            return true;
    return false;
}
