// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/markdown`
 * Purpose: Bind the portable contract test suite to the MarkdownWorkItemAdapter.
 * Scope: Test binding only. Does not test adapter internals; delegates to contract suite.
 * Invariants: Each test gets a clean temp directory with work/items/ and work/projects/.
 * Side-effects: IO (temp directory creation/cleanup)
 * Links: tests/contract/work-item-port.contract.ts
 * @internal
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MarkdownWorkItemAdapter } from "../../src/adapters/markdown/adapter.js";
import { StaleRevisionError } from "../../src/adapters/markdown/errors.js";
import { parseFrontmatter } from "../../src/adapters/markdown/frontmatter.js";
import type { WorkItemId } from "../../src/types.js";
import { workItemPortContract } from "../contract/work-item-port.contract.js";

describe("MarkdownWorkItemAdapter", () => {
  workItemPortContract(async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "work-items-test-"));
    await mkdir(path.join(tmpDir, "work", "items"), { recursive: true });
    await mkdir(path.join(tmpDir, "work", "projects"), { recursive: true });

    const adapter = new MarkdownWorkItemAdapter(tmpDir);

    return {
      query: adapter,
      command: adapter,
      getRevision: async (id: WorkItemId): Promise<string> => {
        // Find the file and compute its revision
        const itemsDir = path.join(tmpDir, "work", "items");
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(itemsDir);
        for (const file of files) {
          const content = await readFile(path.join(itemsDir, file), "utf8");
          const { raw, revision } = parseFrontmatter(content);
          if (String(raw.id) === String(id)) {
            return revision;
          }
        }
        throw new Error(`File not found for ID: ${String(id)}`);
      },
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true });
      },
    };
  });
});

// story.5096 parity: the markdown adapter's CAS is its file-revision check.
describe("MarkdownWorkItemAdapter.setPriorityRank", () => {
  it("sets priority, clears rank on null, and refuses a stale revision", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "work-items-prio-"));
    try {
      await mkdir(path.join(tmpDir, "work", "items"), { recursive: true });
      await mkdir(path.join(tmpDir, "work", "projects"), { recursive: true });
      const adapter = new MarkdownWorkItemAdapter(tmpDir);
      const item = await adapter.create({
        type: "task",
        title: "prioritize",
        priority: 3,
        rank: 9,
      });
      const itemsDir = path.join(tmpDir, "work", "items");
      const { readdir } = await import("node:fs/promises");
      const [file] = await readdir(itemsDir);
      const revisionOf = async () =>
        parseFrontmatter(
          await readFile(path.join(itemsDir, String(file)), "utf8")
        ).revision;
      const before = await revisionOf();

      const updated = await adapter.setPriorityRank({
        id: item.id,
        expectedRevision: before,
        priority: 0,
        rank: null,
      });
      expect(updated.priority).toBe(0);
      expect(updated.rank).toBeUndefined();

      await expect(
        adapter.setPriorityRank({
          id: item.id,
          expectedRevision: before,
          priority: 4,
          rank: 1,
        })
      ).rejects.toBeInstanceOf(StaleRevisionError);
      expect((await adapter.get(item.id))?.priority).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
