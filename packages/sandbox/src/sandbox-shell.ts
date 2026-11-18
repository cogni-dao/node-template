// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/sandbox/sandbox-shell`
 * Purpose: Run one model-written command in one run's folder of the node's sandbox, and keep the sandbox clean.
 * Scope: Wraps ExecdSandboxClient with the call wrapper, per-run ordering and the cleanup tick. Does not read env,
 *   write logs, know the run's identity (the caller passes `runId`) or expose a model-facing tool.
 * Invariants:
 *   - USER_TEXT_NEVER_IN_A_SHELL_STRING: the `command` execd runs is fixed; the model's text, the folder and the limit
 *     travel in `envs` (SB_CMD, SB_DIR, SB_SECS).
 *   - ONE_AFTER_ANOTHER: calls with the same runId run in arrival order; different runs run at once. No app-side cap.
 *   - RUN_ID_IS_A_UUID: the folder name is checked before it reaches the sandbox.
 *   - TIMEOUT_ONLY_AT_THE_LIMIT: `timeout` is reported only when the call ran to its limit; any other failure is `nonzero_exit`.
 *   - TICK_ON_USE_ONLY: the cleanup tick runs at most every 5 minutes, and only when a call arrives.
 * Side-effects: IO (HTTPS to the sandbox lease); reports each tick reading to the injected `onTick`
 * Links: https://node-template.cognidao.org/knowledge/node-sandbox-design, https://node-template.cognidao.org/knowledge/node-sandbox-lifecycle
 * @public
 */

import { type ExecdSandboxClient, SandboxRequestError } from "./execd-client";

export const MAX_COMMAND_BYTES = 16 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;
/** execd's own timeout sits this far above the call's limit, as a safety net. */
const EXECD_MARGIN_MS = 10_000;
const TICK_INTERVAL_MS = 5 * 60_000;
const TICK_TIMEOUT_MS = 30_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fixed text; the model's command is `$SB_CMD`, never part of this string. */
export const CALL_WRAPPER =
  'set -m; mkdir -p "$SB_DIR" && cd "$SB_DIR" && touch .last || exit 125; ' +
  'timeout -s KILL "$SB_SECS" bash -c "$SB_CMD" & p=$!; wait $p; rc=$?; ' +
  "kill -KILL -- -$p 2>/dev/null; exit $rc";

/** Reaps run folders idle for 60 minutes and prints one reading line (node-sandbox-lifecycle). */
export const MAINTENANCE_COMMAND = `old=$(find /workspace -mindepth 2 -maxdepth 2 -name .last -mmin +60 -printf '%h\\n')
printf '%s\\n' "$old" | grep . | xargs -r -d '\\n' rm -rf
printf 'reaped=%s workspaces=%s disk_used_pct=%s mem_current=%s mem_max=%s\\n' \\
  "$(printf '%s' "$old" | grep -c .)" "$(find /workspace -mindepth 1 -maxdepth 1 -type d | wc -l)" \\
  "$(df -P /workspace | awk 'NR==2{print $5+0}')" \\
  "$(cat /sys/fs/cgroup/memory.current)" "$(cat /sys/fs/cgroup/memory.max)"`;

/** bash's own job line when the wrapper kills a call: `bash: line 1: 12 Killed ...` or `[1]+ Killed ...`. */
const KILLED_JOB_LINE = /^(?:(?:\S+: )?line \d+: +\d+|\[\d+\][+-]?) +Killed\b.*(?:\n|$)/gm;

/** One command for the calling run's folder. Structurally the `@cogni-dao/ai-tools` SandboxShellParams. */
export interface SandboxShellParams {
  /** Shell text; may be a multi-line script. */
  readonly command: string;
  /** Call limit in milliseconds, 1000..900000. */
  readonly timeoutMs: number;
}

/** `none` = exit 0; `nonzero_exit` = the command failed; `timeout` = the call ran to its limit. */
export type SandboxShellErrorCode = "none" | "nonzero_exit" | "timeout";

/** Structurally the `@cogni-dao/ai-tools` SandboxShellResult. */
export interface SandboxShellResult {
  readonly exitCode: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly errorCode: SandboxShellErrorCode;
}

export interface SandboxShellRun extends SandboxShellParams {
  /** The calling run's id; its folder is `/workspace/<runId>`. */
  readonly runId: string;
}

/** One cleanup tick: the lease's readings, or `errorCode` when the tick failed. Counts and sizes only. */
export type SandboxTickReport =
  | {
      readonly reaped: number;
      readonly workspaces: number;
      readonly diskUsedPct: number;
      /** Bytes, or `unknown` when the lease's cgroup files are missing. */
      readonly memCurrent: string;
      readonly memMax: string;
    }
  | { readonly errorCode: "transport_error" };

export class SandboxShell {
  /** The last call of each run that has calls waiting or running; the next call of that run chains onto it. */
  private readonly tails = new Map<string, Promise<void>>();
  private lastTickAt = 0;

  constructor(
    private readonly client: Pick<ExecdSandboxClient, "runCommand">,
    private readonly onTick: (report: SandboxTickReport) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  async run(call: SandboxShellRun): Promise<SandboxShellResult> {
    const { runId, command, timeoutMs } = call;
    if (!UUID.test(runId)) {
      throw new SandboxRequestError("run id is not a UUID", null);
    }
    if (new TextEncoder().encode(command).length > MAX_COMMAND_BYTES) {
      throw new SandboxRequestError("command is over 16 KiB", null);
    }
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new SandboxRequestError("timeoutMs is outside 1000..900000", null);
    }
    this.maybeTick();
    return this.afterEarlierCallsOf(runId, () =>
      this.runOne(runId, command, Math.ceil(timeoutMs / 1000))
    );
  }

  private afterEarlierCallsOf<T>(
    runId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const result = (this.tails.get(runId) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(runId, tail);
    void tail.then(() => {
      if (this.tails.get(runId) === tail) this.tails.delete(runId);
    });
    return result;
  }

  private async runOne(
    runId: string,
    command: string,
    seconds: number
  ): Promise<SandboxShellResult> {
    const startedAt = this.now();
    const result = await this.client.runCommand({
      command: CALL_WRAPPER,
      timeoutMs: seconds * 1000 + EXECD_MARGIN_MS,
      envs: {
        SB_DIR: `/workspace/${runId}`,
        SB_CMD: command,
        SB_SECS: String(seconds),
      },
    });
    const ranToLimit = this.now() - startedAt >= seconds * 1000;
    return {
      exitCode: result.exitCode,
      output: result.output.replace(KILLED_JOB_LINE, ""),
      truncated: result.truncated,
      errorCode:
        result.exitCode === 0
          ? "none"
          : result.exitCode === 137 && ranToLimit
            ? "timeout"
            : "nonzero_exit",
    };
  }

  /** At most one tick every 5 minutes, started by a call; it never delays that call. */
  private maybeTick(): void {
    const at = this.now();
    if (at - this.lastTickAt < TICK_INTERVAL_MS) return;
    this.lastTickAt = at;
    void this.tick();
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.client.runCommand({
        command: MAINTENANCE_COMMAND,
        timeoutMs: TICK_TIMEOUT_MS,
      });
      const reading =
        /reaped=(\d+) workspaces=(\d+) disk_used_pct=(\d+) mem_current=(\S*) mem_max=(\S*)/.exec(
          result.output
        );
      if (!reading) throw new Error("no reading line");
      this.onTick({
        reaped: Number(reading[1]),
        workspaces: Number(reading[2]),
        diskUsedPct: Number(reading[3]),
        memCurrent: reading[4] || "unknown",
        memMax: reading[5] || "unknown",
      });
    } catch {
      this.onTick({ errorCode: "transport_error" });
    }
  }
}
