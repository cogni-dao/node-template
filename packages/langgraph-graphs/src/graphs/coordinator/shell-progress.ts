// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/coordinator/shell-progress`
 * Purpose: What a chat coding run actually did in the sandbox, from the shell tool's own receipts.
 * Scope: Pure bookkeeping over observed tool calls. Never from model text.
 * Invariants:
 *   - RECEIPTS_ONLY: a commit, push or pull request counts only when a shell call that ran it exited 0
 * Side-effects: none
 * Links: https://node-template.cognidao.org/work/items/bug.0080
 * @internal
 */

import { z } from "zod";

const input = z.object({ command: z.string() });
const output = z.object({ status: z.string(), exitCode: z.number(), output: z.string() });
const PULL_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

/** `yes`: the receipt proves it. `unknown`: a command ran but its exit code cannot prove it. `no`: nothing ran. */
export type Established = "yes" | "unknown" | "no";

export interface ShellProgressSummary {
  readonly commands: number;
  readonly branch: string | null;
  readonly committed: Established;
  readonly pushed: Established;
  readonly pullRequest: string | null;
}

/**
 * Whether an exit code of 0 proves every step of the command ran. A pipe, `;`, `||`, a background `&` or a second line
 * makes the exit code the last step's, so a `git push` inside it may have failed. Only an `&&` chain proves it. This is
 * conservative: a quoted `;` also reads as unknown.
 */
function exitCodeProvesAllSteps(command: string): boolean {
  const text = command.trim().replace(/\\\n/g, " ").replace(/\d*>&\d+/g, "");
  return !/[|;\n]|(?<!&)&(?!&)/.test(text.replace(/&&\s*\n\s*/g, "&& "));
}

/** `git push -n` is a dry run; `git commit -n` is not (it skips hooks), so only push reads `-n`. */
const PUSH_DRY_RUN = /--dry-run|(?:^|\s)-n(?:\s|$)/;
const COMMIT_DRY_RUN = /--dry-run/;

export class ShellProgress {
  private commands = 0;
  private branch: string | null = null;
  private committed: Established = "no";
  private pushed: Established = "no";
  private pullRequest: string | null = null;

  observe(args: unknown, result: { ok: boolean; value?: unknown }) {
    const call = input.safeParse(args);
    if (!call.success) return;
    this.commands += 1;
    const out = result.ok ? output.safeParse(result.value) : undefined;
    if (!out?.success || out.data.status !== "ok" || out.data.exitCode !== 0) return;
    const { command } = call.data;
    const proven = exitCodeProvesAllSteps(command);
    const made = /\bgit\s+(?:checkout\s+-b|switch\s+-c)\s+([^\s;&|]+)/.exec(command);
    if (made?.[1] && proven) this.branch = made[1];
    this.mark("committed", /\bgit\s+commit\b/.test(command) && !COMMIT_DRY_RUN.test(command), proven);
    this.mark("pushed", /\bgit\s+push\b/.test(command) && !PUSH_DRY_RUN.test(command), proven);
    if (/\bgh\s+pr\s+create\b|\/pulls\b/.test(command))
      this.pullRequest = PULL_URL.exec(out.data.output)?.[0] ?? this.pullRequest;
  }

  private mark(field: "committed" | "pushed", ran: boolean, proven: boolean) {
    if (!ran || this[field] === "yes") return;
    this[field] = proven ? "yes" : "unknown";
  }

  summary(): ShellProgressSummary {
    return {
      commands: this.commands,
      branch: this.branch,
      committed: this.committed,
      pushed: this.pushed,
      pullRequest: this.pullRequest,
    };
  }
}

/**
 * The chat answer for a run that reached its step limit: what it did, and the one next step that is possible. A
 * follow-up is a new run in a fresh sandbox, so only work already pushed to the remote survives; an unpushed commit is
 * lost, and the answer says so instead of promising to continue it.
 */
export function chatStepBudgetAnswer(progress: ShellProgressSummary): string {
  const commit = progress.committed === "no" ? "none" : progress.committed;
  const did = progress.commands
    ? `I ran ${progress.commands} sandbox command${progress.commands === 1 ? "" : "s"}. Branch: ${progress.branch ?? "none"}. Commit: ${commit}. Pushed: ${progress.pushed}. Pull request: ${progress.pullRequest ?? "none"}.`
    : "I made no changes in the sandbox.";
  const next = progress.pullRequest
    ? "The pull request is open; review it, or tell me what to change."
    : progress.pushed === "yes"
      ? "The pushed branch keeps that work. Next: open the pull request. Ask me to continue."
      : progress.pushed === "unknown"
        ? "I could not confirm the push from the command receipts, so check the remote branch before asking me to continue."
        : progress.committed !== "no"
          ? "The commit was never pushed, so it is lost with this run's sandbox; a follow-up run starts over from the last pushed state. Ask me again, and ask me to push early."
          : progress.commands
            ? "Nothing was committed, so a follow-up run starts over. Ask me again with a narrower request."
            : "Next: ask me again with a narrower request, or tell me where to start.";
  return `I reached this run's step limit before finishing. ${did} A follow-up run starts in a fresh sandbox. ${next}`;
}
