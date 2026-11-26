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

export interface ShellProgressSummary {
  readonly commands: number;
  readonly branch: string | null;
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly pullRequest: string | null;
}

export class ShellProgress {
  private commands = 0;
  private branch: string | null = null;
  private committed = false;
  private pushed = false;
  private pullRequest: string | null = null;

  observe(args: unknown, result: { ok: boolean; value?: unknown }) {
    const call = input.safeParse(args);
    if (!call.success) return;
    this.commands += 1;
    const out = result.ok ? output.safeParse(result.value) : undefined;
    if (!out?.success || out.data.status !== "ok" || out.data.exitCode !== 0) return;
    const { command } = call.data;
    const made = /\bgit\s+(?:checkout\s+-b|switch\s+-c)\s+([^\s;&|]+)/.exec(command);
    if (made?.[1]) this.branch = made[1];
    if (/\bgit\s+commit\b/.test(command)) this.committed = true;
    if (/\bgit\s+push\b/.test(command)) this.pushed = true;
    if (/\bgh\s+pr\s+create\b|\/pulls\b/.test(command))
      this.pullRequest = PULL_URL.exec(out.data.output)?.[0] ?? this.pullRequest;
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
 * The chat answer for a run that reached its step limit: what it did, and the one next step. A user reads it, so it
 * says branch, commit and pull request plainly, and "none" when there is none.
 */
export function chatStepBudgetAnswer(progress: ShellProgressSummary): string {
  const did = progress.commands
    ? `I ran ${progress.commands} sandbox command${progress.commands === 1 ? "" : "s"}. Branch: ${progress.branch ?? "none"}. Commit: ${progress.committed ? "yes" : "none"}. Pushed: ${progress.pushed ? "yes" : "no"}. Pull request: ${progress.pullRequest ?? "none"}.`
    : "I made no changes in the sandbox.";
  const next = progress.pullRequest
    ? "The pull request is open; review it, or tell me what to change."
    : progress.pushed
      ? "Next: open the pull request. Ask me to continue."
      : progress.committed
        ? "Next: push the branch and open the pull request. Ask me to continue."
        : progress.commands
          ? "Next: finish the edit, commit, push and open the pull request. Ask me to continue, or narrow the request."
          : "Next: ask me again with a narrower request, or tell me where to start.";
  // A follow-up is a new run in a fresh sandbox: only work already pushed to the remote carries over.
  return `I reached this run's step limit before finishing. ${did} Only pushed work carries over; a follow-up run starts in a fresh sandbox. ${next}`;
}
