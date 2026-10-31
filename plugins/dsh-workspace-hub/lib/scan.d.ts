/** Outcome of one best-effort scan attempt. */
export interface ScanResult {
    /** `true` only when the CLI exited 0. */
    readonly ok: boolean;
    /** `true` when no usable CLI was found; activation continues with the current ledger. */
    readonly skipped: boolean;
    /** CLI exit code when it ran and failed. */
    readonly exitCode?: number;
    /** Human-readable detail (Chinese); present on skip/failure. */
    readonly message?: string;
    /** Last ~2KB of stdout, for diagnostics. */
    readonly stdoutTail?: string;
    /** Last ~2KB of stderr, for diagnostics. */
    readonly stderrTail?: string;
}
/**
 * Prefer the CLI shipped in this npm package; retain the old checkout path
 * as a fallback for development checkouts without the vendored source.
 * @returns absolute candidate path (existence is checked by the caller)
 */
export declare function defaultHubCliPath(): string;
/** Inputs for {@link runHubScan}. */
export interface ScanOptions {
    readonly cliPath: string;
    readonly ledgerPath: string;
    readonly timeoutMs: number;
}
/**
 * Run `wshub scan --save --home <ledger dir>` with a hard timeout.
 * Never throws: every failure becomes a {@link ScanResult}.
 * @param options CLI path, ledger path, and timeout
 * @returns the scan outcome
 */
export declare function runHubScan(options: ScanOptions): Promise<ScanResult>;
/** Inputs for {@link runHubCommand}. */
export interface CommandOptions {
    readonly cliPath: string;
    readonly args: string[];
    readonly timeoutMs: number;
}
/** Run any `wshub` subcommand with a timeout; never throws. */
export declare function runHubCommand(options: CommandOptions): Promise<ScanResult & {
    stdout: string;
}>;
