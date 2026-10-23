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

import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MarkdownWorkItemAdapter } from "../../src/adapters/markdown/adapter.js";
import { UnsupportedWorkItemFieldError } from "../../src/adapters/markdown/errors.js";
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

describe("MarkdownWorkItemAdapter — scores are Doltgres-only (story.5111)", () => {
  const scores = { ease: { v: 3 } };

  async function harness() {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "work-items-scores-"));
    const itemsDir = path.join(tmpDir, "work", "items");
    await mkdir(itemsDir, { recursive: true });
    await mkdir(path.join(tmpDir, "work", "projects"), { recursive: true });
    return { tmpDir, itemsDir, adapter: new MarkdownWorkItemAdapter(tmpDir) };
  }

  it("create with scores throws UnsupportedWorkItemFieldError and writes no file", async () => {
    const { tmpDir, itemsDir, adapter } = await harness();
    try {
      await expect(
        adapter.create({ type: "task", title: "scored", scores })
      ).rejects.toMatchObject({
        name: "UnsupportedWorkItemFieldError",
        code: "work_item_field_unsupported",
        field: "scores",
      });
      await expect(
        adapter.create({ type: "task", title: "scored", scores })
      ).rejects.toBeInstanceOf(UnsupportedWorkItemFieldError);
      expect(await readdir(itemsDir)).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["an object", scores],
    ["null", null],
  ])("patch with scores = %s throws and leaves the file untouched", async (_label, value) => {
    const { tmpDir, itemsDir, adapter } = await harness();
    try {
      const created = await adapter.create({ type: "task", title: "plain" });
      const [file] = await readdir(itemsDir);
      const filePath = path.join(itemsDir, file as string);
      const before = await readFile(filePath, "utf8");
      const { revision } = parseFrontmatter(before);

      await expect(
        adapter.patch({
          id: created.id,
          expectedRevision: revision,
          set: { title: "renamed", scores: value },
        })
      ).rejects.toBeInstanceOf(UnsupportedWorkItemFieldError);
      expect(await readFile(filePath, "utf8")).toBe(before);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
