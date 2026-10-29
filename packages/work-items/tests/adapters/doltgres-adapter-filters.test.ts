// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * bug.5552: the Doltgres list() must emit the right WHERE fragments for the new
 * labels / labelPrefix / scored filters. The fake captures emitted SQL; row-level
 * semantics are proved on candidate (scores are Doltgres-only). This guards the
 * generated SQL shape so a refactor cannot silently drop a filter clause.
 */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";
import {
  independentReadPool,
  makeFakeDoltgresSql
} from "./fake-doltgres-sql.js";
import type { WorkQuery } from "../../src/types.js";

/** Run list() with the fake and return the generated work_items SELECT SQL. */
async function capturedListSql(query: WorkQuery): Promise<string> {
  const queries: string[] = [];
  const reader: Sql = makeFakeDoltgresSql(() => [], queries);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(reader), {
    readClient: reader
  });
  await adapter.list(query);
  const select = queries.find(
    (q) => q.includes("FROM work_items") && q.includes("AS ordered")
  );
  expect(select, "expected a work_items list SELECT to be emitted").toBeDefined();
  return select as string;
}

describe("DoltgresWorkItemAdapter list filters (bug.5552)", () => {
  it("labels emits an any-of jsonb membership EXISTS clause", async () => {
    const sql = await capturedListSql({ labels: ["goal", "roadmap"] });
    expect(sql).toContain("jsonb_array_elements_text(labels)");
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("'goal'");
    expect(sql).toContain("'roadmap'");
  });

  it("labelPrefix emits a LEFT() prefix match on label elements", async () => {
    const sql = await capturedListSql({ labelPrefix: "area:" });
    expect(sql).toContain("jsonb_array_elements_text(labels)");
    expect(sql).toContain("LEFT(l, 5)");
    expect(sql).toContain("'area:'");
  });

  it("scored:true emits rankScore IS NOT NULL", async () => {
    // Non-rankScore sort so rankScoreSql() appears only in the scored predicate.
    const sql = await capturedListSql({ scored: true, sortBy: "createdAt" });
    expect(sql).toContain("scores -> 'agent'");
    expect(sql).toContain("IS NOT NULL");
    expect(sql).not.toContain(") IS NULL");
  });

  it("scored:false emits rankScore IS NULL", async () => {
    const sql = await capturedListSql({ scored: false, sortBy: "createdAt" });
    expect(sql).toContain("scores -> 'agent'");
    expect(sql).toContain(") IS NULL");
  });
});
