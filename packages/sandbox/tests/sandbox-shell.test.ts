// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/sandbox` sandbox-shell
 * Purpose: Guards the three defects the sandbox shell must not have: model text inside a shell string,
 *   a run folder that is not a UUID, and one run's calls overlapping.
 * Scope: SandboxShell over a fake client. No network.
 * Side-effects: none
 * Links: src/sandbox-shell.ts
 */

import { describe, expect, it } from "vitest";

import type { SandboxCommandRequest, SandboxCommandResult } from "../src/execd-client";
import { SandboxShell, scrubSecrets } from "../src/sandbox-shell";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

const done = (over: Partial<SandboxCommandResult> = {}): SandboxCommandResult => ({
  exitCode: 0,
  output: "",
  truncated: false,
  errorName: null,
  ...over,
});

describe("SandboxShell", () => {
  it("sends fixed wrapper text and puts the model's command only in envs", async () => {
    const seen: SandboxCommandRequest[] = [];
    const shell = new SandboxShell({
      runCommand: async (req) => {
        seen.push(req);
        return done();
      },
    });
    const evil = `echo "$(whoami)"; rm -rf / # '`;
    await shell.run({ runId: RUN_A, command: evil, timeoutMs: 120_000 });

    const call = seen.find((r) => r.envs?.SB_CMD !== undefined);
    expect(call?.command).not.toContain("whoami");
    expect(call?.envs).toEqual({
      SB_DIR: `/workspace/${RUN_A}`,
      SB_CMD: evil,
      SB_SECS: "120",
    });
    expect(call?.timeoutMs).toBe(130_000);
  });

  it("refuses a run id that is not a UUID, an oversized command and a bad limit", async () => {
    const shell = new SandboxShell({ runCommand: async () => done() });
    await expect(
      shell.run({ runId: "../etc", command: "ls", timeoutMs: 5000 })
    ).rejects.toThrow("UUID");
    await expect(
      shell.run({ runId: RUN_A, command: "x".repeat(16 * 1024 + 1), timeoutMs: 5000 })
    ).rejects.toThrow("16 KiB");
    await expect(
      shell.run({ runId: RUN_A, command: "ls", timeoutMs: 10 })
    ).rejects.toThrow("timeoutMs");
  });

  it("runs one run's calls in arrival order, even after a failure, and other runs at once", async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shell = new SandboxShell({
      runCommand: async (req) => {
        const cmd = req.envs?.SB_CMD;
        if (cmd === undefined) return done(); // the cleanup tick
        log.push(`start ${cmd}`);
        if (cmd === "a1") await gate;
        log.push(`end ${cmd}`);
        return done({ exitCode: cmd === "a1" ? 2 : 0 });
      },
    });
    const a1 = shell.run({ runId: RUN_A, command: "a1", timeoutMs: 5000 });
    const a2 = shell.run({ runId: RUN_A, command: "a2", timeoutMs: 5000 });
    const b1 = shell.run({ runId: RUN_B, command: "b1", timeoutMs: 5000 });
    await b1;
    expect(log).toEqual(["start a1", "start b1", "end b1"]);
    release();
    const [r1, r2] = await Promise.all([a1, a2]);
    expect(log.slice(3)).toEqual(["end a1", "start a2", "end a2"]);
    expect(r1.errorCode).toBe("nonzero_exit");
    expect(r2.errorCode).toBe("none");
  });

  it("reports timeout only when the call ran to its limit", async () => {
    let clock = 0;
    const shell = new SandboxShell(
      { runCommand: async () => done({ exitCode: 137, output: "x\nbash: line 1:   9 Killed  timeout" }) },
      undefined,
      () => clock
    );
    // An out-of-memory 137 long before the limit is a plain failure.
    const early = await shell.run({ runId: RUN_A, command: "oom", timeoutMs: 5000 });
    expect(early.errorCode).toBe("nonzero_exit");
    expect(early.output).toBe("x\n");

    const slow = new SandboxShell(
      {
        runCommand: async () => {
          clock += 5000;
          return done({ exitCode: 137 });
        },
      },
      undefined,
      () => clock
    );
    const late = await slow.run({ runId: RUN_A, command: "sleep 9", timeoutMs: 5000 });
    expect(late.errorCode).toBe("timeout");
  });

  it("sends the cleanup tick at most every 5 minutes and reports its reading", async () => {
    let clock = 10 * 60_000;
    const reports: unknown[] = [];
    let ticks = 0;
    const shell = new SandboxShell(
      {
        runCommand: async (req) => {
          if (req.envs?.SB_CMD !== undefined) return done();
          ticks += 1;
          return done({
            output: "reaped=2 workspaces=3 disk_used_pct=11 mem_current=100 mem_max=max",
          });
        },
      },
      (r) => reports.push(r),
      () => clock
    );
    await shell.run({ runId: RUN_A, command: "ls", timeoutMs: 5000 });
    clock += 60_000;
    await shell.run({ runId: RUN_A, command: "ls", timeoutMs: 5000 });
    clock += 5 * 60_000;
    await shell.run({ runId: RUN_A, command: "ls", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(ticks).toBe(2);
    expect(reports[0]).toEqual({
      reaped: 2,
      workspaces: 3,
      diskUsedPct: 11,
      memCurrent: "100",
      memMax: "unknown",
    });
  });

  it("never returns a GitHub token that a command printed", async () => {
    const pat = `github_pat_${"A".repeat(30)}`;
    const classic = `ghp_${"b".repeat(36)}`;
    const shell = new SandboxShell({
      runCommand: async () => done({ output: `token=${pat} other=${classic}` }),
    });
    const result = await shell.run({ runId: RUN_A, command: "env", timeoutMs: 5000 });
    expect(result.output).not.toContain(pat);
    expect(result.output).not.toContain(classic);
    expect(scrubSecrets("plain text")).toBe("plain text");
  });
});
