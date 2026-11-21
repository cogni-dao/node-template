// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Complete epoch summaries on native PostgreSQL: no receipt-page denominator or missing-projection hole. */
import { randomUUID } from "node:crypto";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import {
  readEpochContributorSummary,
  readEpochOverview,
} from "@cogni/attribution-ledger/http";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor } from "@tests/_fixtures/stack/seed";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

describe("public attribution presentation on PostgreSQL", () => {
  const db = getSeedDb();
  let nodeId: string;
  let scopeId: string;
  let store: InstanceType<typeof DrizzleAttributionAdapter>;
  let epochId: bigint;
  let a: string;
  let b: string;
  let prefix: string;
  const periodStart = new Date("2026-11-16T00:00:00Z");
  const periodEnd = new Date("2026-11-23T00:00:00Z");

  beforeEach(async () => {
    nodeId = randomUUID();
    scopeId = randomUUID();
    prefix = randomUUID();
    store = new DrizzleAttributionAdapter(db, scopeId);
    a = (await seedTestActor(db)).user.id;
    b = (await seedTestActor(db)).user.id;
    // Backfill an isolated test ledger. No production epoch or signed row is touched.
    await db.execute(sql`INSERT INTO epochs (node_id, scope_id, status, period_start, period_end, weight_config, pool_total_credits, closed_at)
      SELECT ${nodeId}::uuid, ${scopeId}::uuid, 'finalized', '2020-01-06'::timestamptz + n * interval '7 days',
        '2020-01-13'::timestamptz + n * interval '7 days', '{}'::jsonb, 0, '2020-01-13'::timestamptz + n * interval '7 days'
      FROM generate_series(0,200) n`);
    const epoch = await store.createEpoch({
      nodeId,
      scopeId,
      periodStart,
      periodEnd,
      weightConfig: { "github:pr_merged": 1000 },
    });
    epochId = epoch.id;
    const receipts = [
      ...Array.from({ length: 201 }, (_, i) => ({
        receiptId: `${prefix}:a:${i}`,
        platformUserId: "11",
        platformLogin: "Alpha",
        userId: a,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        receiptId: `${prefix}:b:${i}`,
        platformUserId: "22",
        platformLogin: "Beta",
        userId: b,
      })),
      {
        receiptId: `${prefix}:c:0`,
        platformUserId: "33",
        platformLogin: "Unlinked",
        userId: null,
      },
    ];
    await store.insertIngestionReceipts(
      receipts.map((receipt) => ({
        ...receipt,
        nodeId,
        source: "github",
        eventType: "pr_merged",
        payloadHash: "fixture-hash",
        producer: "fixture",
        producerVersion: "1",
        eventTime: periodStart,
        retrievedAt: periodStart,
      }))
    );
    await store.insertSelectionDoNothing(
      receipts.map((receipt) => ({
        nodeId,
        epochId,
        receiptId: receipt.receiptId,
        userId: receipt.userId,
        included: true,
      }))
    );
    await store.upsertUserProjections([
      {
        nodeId,
        epochId,
        userId: a,
        projectedUnits: 201000n,
        receiptCount: 201,
      },
    ]);
  });

  it("returns the current epoch after more than200 historical rows", async () => {
    const overview = await readEpochOverview(store, nodeId, {
      limit: 200,
      offset: 0,
    });
    expect(overview.current?.id).toBe(epochId.toString());
    expect(overview.total).toBe(201);
    expect(overview.epochs).toHaveLength(200);
    expect(overview.epochs.every((epoch) => epoch.status === "finalized")).toBe(
      true
    );
  });

  it("uses each projection once and includes off-page resolved and unresolved contributors", async () => {
    const page = await readEpochContributorSummary(store, nodeId, epochId, {
      limit: 200,
      offset: 0,
    });
    expect(page).toMatchObject({
      total: 3,
      totalUnits: "204000",
      totalPoints: "204",
      totalReceiptCount: 204,
    });
    expect(
      page?.items.map((item) => [
        item.claimantKey,
        item.units,
        item.receiptCount,
      ])
    ).toEqual([
      [`user:${a}`, "201000", 201],
      [`user:${b}`, "2000", 2],
      ["identity:github:33", "1000", 1],
    ]);
    const one = await readEpochContributorSummary(store, nodeId, epochId, {
      limit: 1,
      offset: 1,
    });
    expect(one).toMatchObject({
      total: 3,
      totalUnits: "204000",
      totalReceiptCount: 204,
    });
    expect(one?.items[0]).toEqual(page?.items[1]);
    await expect(
      readEpochContributorSummary(store, randomUUID(), epochId, {
        limit: 1,
        offset: 0,
      })
    ).resolves.toBeNull();
  });

  it("moves a newly linked identity exactly once, then replaces its fallback with a projection", async () => {
    const linked = (await seedTestActor(db)).user.id;
    await store.updateSelectionUserId(epochId, `${prefix}:c:0`, linked);
    const beforeProjection = await readEpochContributorSummary(
      store,
      nodeId,
      epochId,
      { limit: 200, offset: 0 }
    );
    expect(
      beforeProjection?.items.some(
        (item) => item.claimantKey === "identity:github:33"
      )
    ).toBe(false);
    expect(
      beforeProjection?.items.find(
        (item) => item.claimantKey === `user:${linked}`
      )
    ).toMatchObject({ units: "1000", receiptCount: 1 });
    await store.upsertUserProjections([
      {
        nodeId,
        epochId,
        userId: linked,
        projectedUnits: 1000n,
        receiptCount: 1,
      },
    ]);
    const afterProjection = await readEpochContributorSummary(
      store,
      nodeId,
      epochId,
      { limit: 200, offset: 0 }
    );
    expect(afterProjection?.totalUnits).toBe("204000");
    expect(
      afterProjection?.items.filter(
        (item) => item.claimantKey === `user:${linked}`
      )
    ).toHaveLength(1);
    expect(
      afterProjection?.items.find(
        (item) => item.claimantKey === `user:${linked}`
      )?.units
    ).toBe("1000");
  });
  it("keeps zero overrides and reset access for both fallback groups through projection arrival", async () => {
    await db.execute(
      sql`UPDATE epochs SET status = 'review' WHERE id = ${epochId} AND node_id = ${nodeId}::uuid`
    );
    for (const receiptId of [
      `${prefix}:b:0`,
      `${prefix}:b:1`,
      `${prefix}:c:0`,
    ]) {
      await store.upsertReviewSubjectOverride({
        nodeId,
        epochId,
        subjectRef: receiptId,
        overrideUnits: 0n,
        overrideReason: "zero regression",
      });
    }
    const before = await readEpochContributorSummary(store, nodeId, epochId, {
      limit: 200,
      offset: 0,
    });
    expect(before).toMatchObject({
      total: 3,
      totalUnits: "201000",
      totalReceiptCount: 204,
      unresolvedCount: 1,
      unresolvedActivityTotal: 1,
    });
    expect(
      before?.items.find((item) => item.claimantKey === `user:${b}`)
    ).toMatchObject({ units: "0", receiptCount: 2 });
    expect(
      before?.items.find((item) => item.claimantKey === "identity:github:33")
    ).toMatchObject({ units: "0", receiptCount: 1 });
    for (const key of [`user:${b}`, "identity:github:33"]) {
      const details = await store.getContributorReceiptsPage(
        nodeId,
        epochId,
        key,
        { limit: 50, offset: 0 }
      );
      expect(details.receipts.length).toBeGreaterThan(0);
    }
    await store.upsertUserProjections([
      { nodeId, epochId, userId: b, projectedUnits: 2000n, receiptCount: 2 },
    ]);
    const after = await readEpochContributorSummary(store, nodeId, epochId, {
      limit: 200,
      offset: 0,
    });
    expect(after).toEqual(before);
    for (const receiptId of [`${prefix}:b:0`, `${prefix}:b:1`, `${prefix}:c:0`])
      await store.deleteReviewSubjectOverride(epochId, receiptId);
    const reset = await readEpochContributorSummary(store, nodeId, epochId, {
      limit: 200,
      offset: 0,
    });
    expect(reset).toMatchObject({
      total: 3,
      totalUnits: "204000",
      totalReceiptCount: 204,
      unresolvedCount: 1,
    });
  });

  it("returns stable complete unresolved facts across actual dense contributor and receipt pages", async () => {
    const receipts = Array.from({ length: 201 }, (_, i) => ({
      nodeId,
      receiptId: `${prefix}:dense:${i}`,
      source: "github",
      eventType: "pr_merged",
      platformUserId: `dense-${i}`,
      platformLogin: "Same label",
      payloadHash: "dense-fixture",
      producer: "fixture",
      producerVersion: "1",
      eventTime: periodStart,
      retrievedAt: periodStart,
    }));
    await store.insertIngestionReceipts(receipts);
    await store.insertSelectionDoNothing(
      receipts.map((receipt) => ({
        nodeId,
        epochId,
        receiptId: receipt.receiptId,
        userId: null,
        included: true,
      }))
    );
    const first = await readEpochContributorSummary(store, nodeId, epochId, {
      limit: 200,
      offset: 0,
    });
    const last = await readEpochContributorSummary(store, nodeId, epochId, {
      limit: 200,
      offset: 200,
    });
    expect(first?.items).toHaveLength(200);
    expect(last?.items).toHaveLength(4);
    for (const page of [first, last]) {
      expect(page).toMatchObject({
        total: 204,
        totalUnits: "405000",
        totalReceiptCount: 405,
        unresolvedCount: 202,
        unresolvedActivityTotal: 202,
      });
      expect(page?.unresolvedActivities).toHaveLength(200);
      expect(
        new Set(page?.unresolvedActivities.map((item) => item.claimantKey)).size
      ).toBe(200);
    }
    expect(last?.unresolvedActivities).toEqual(first?.unresolvedActivities);
    await store.updateSelectionUserId(epochId, `${prefix}:c:0`, b);
    const linked = await readEpochContributorSummary(store, nodeId, epochId, {
      limit: 1,
      offset: 200,
    });
    expect(linked).toMatchObject({
      total: 203,
      totalUnits: "405000",
      totalReceiptCount: 405,
      unresolvedCount: 201,
      unresolvedActivityTotal: 201,
    });
  });
});
