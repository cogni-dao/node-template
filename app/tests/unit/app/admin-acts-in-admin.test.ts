// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin-acts-in-admin`
 * Purpose: ADMIN_ACTS_IN_ADMIN for the node-wide AI approvals (task.0114): every importer of AgentAccessSection or the agent-access endpoints constant lives under src/app/(admin)/.
 * Scope: Reads source files only; renders nothing.
 * Invariants: ADMIN_ACTS_IN_ADMIN.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../../src");
const ADMIN_DIR = "app/(admin)/";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("ADMIN_ACTS_IN_ADMIN", () => {
  it("imports AgentAccessSection and the agent-access endpoints only from src/app/(admin)/", () => {
    const importers = sourceFiles(SRC)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return (
          /import[^;]*\bAgentAccessSection\b[^;]*from/.test(text) ||
          /from\s+["'][^"']*agent-access-endpoints["']/.test(text)
        );
      })
      .map((file) => relative(SRC, file));
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((file) => !file.startsWith(ADMIN_DIR))).toEqual([]);
  });
});
