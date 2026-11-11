// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/node-declarations/tests/cli`
 * Purpose: Prove the `node-declarations-check` CLI: required `--node-slug`, absent catalog passes,
 *   issues exit 1, and output carries no value.
 * Scope: Calls `runCli` on a throwaway directory; needs no build. The built executable is exercised by the falsifier run, not here.
 * Invariants: NODE_SLUG_IS_INPUT, NO_SOURCE_ECHO.
 * Side-effects: IO (temp directory)
 * Links: packages/node-declarations/src/cli.ts, bug.5254
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli-run";

const dirs: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "node-declarations-"));
  dirs.push(root);
  mkdirSync(join(root, ".cogni"));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, ".cogni", name), text);
  return root;
}

function run(args: string[]) {
  const result = runCli(args);
  return { code: result.code, out: result.stdout + result.stderr };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("node-declarations-check", () => {
  it("requires --node-slug and --repo-root (exit 2)", () => {
    const root = repo({ "repo-spec.yaml": "intent:\n  name: demo\n" });
    expect(run(["--repo-root", root]).code).toBe(2);
    expect(run(["--node-slug", "demo"]).code).toBe(2);
  });

  it("passes with an absent catalog", () => {
    const root = repo({ "repo-spec.yaml": "intent:\n  name: demo\n" });
    const result = run(["--repo-root", root, "--node-slug", "demo"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("ok (demo)");
  });

  it("fails on a stray secret_refs and never prints its value", () => {
    const root = repo({
      "repo-spec.yaml": "intent:\n  name: demo\nsecret_refs:\n  - key: sk-live-MARKER123\n",
    });
    const result = run(["--repo-root", root, "--node-slug", "demo"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("[retired_secret_refs]");
    expect(result.out).not.toContain("MARKER123");
  });

  it("fails when the repo-spec is missing", () => {
    const root = repo({});
    expect(run(["--repo-root", root, "--node-slug", "demo"]).code).toBe(1);
  });
});
