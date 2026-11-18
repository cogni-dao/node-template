// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/scripts/migrate-doltgres-receipt`
 * Purpose: The Doltgres migrator's receipt names each applied migration by its journal tag (task.0122), so a candidate log proves
 *   "0007_..." and "0008_..." ran without reading the database.
 * Scope: `journalTags` over this node's real journal; no database.
 * Invariants: every journal entry maps `when` to its tag; an unreadable journal names nothing and never throws.
 * Side-effects: filesystem reads
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error a plain .mjs script with no declarations
import { journalTags } from "../../../../scripts/db/migrate-doltgres.mjs";

const FOLDER = resolve(__dirname, "../../../src/adapters/server/db/doltgres-migrations");

describe("migrate-doltgres journalTags", () => {
  it("maps each journal `when` to its migration tag, the status ladder and the artifact migrations by name", () => {
    const tags: Map<number, string> = journalTags(FOLDER);
    const names = [...tags.values()];
    expect(names).toContain("0007_work_item_artifact_sequence");
    expect(names).toContain("0008_work_item_status_ladder");
  });

  it("names nothing for a missing or unreadable journal, and never throws", () => {
    expect(journalTags("/nonexistent/folder").size).toBe(0);
    expect(journalTags(resolve(__dirname)).size).toBe(0);
  });
});
