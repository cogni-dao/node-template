// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** PostgreSQL receiver races: facade adoption, stale completion, replay and admission. */
import { createHash, randomUUID } from "node:crypto";
import {
  type Database,
  DrizzleExecutionRequestAdapter,
  DrizzleGraphRunAdapter,
  DrizzleManagedExecutionAdapter,
} from "@cogni/db-client";
import { billingAccounts, users } from "@cogni/db-schema/refs";
import {
  executionGrants,
  executionRequests,
  graphRuns,
  schedules,
} from "@cogni/db-schema/scheduling";
import {
  type CanonicalRunResult,
  canonicalTerminal,
  type ManagedExecutionBinding,
  type ManagedExecutionClaim,
} from "@cogni/graph-execution-host";
import { SYSTEM_ACTOR } from "@cogni/ids/system";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb } from "@/adapters/server/db/client";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const actor = randomUUID();
const otherActor = randomUUID();
const accountId = randomUUID();
const scheduleIds: string[] = [];
const grantIds: string[] = [];
const keys: string[] = [];
const runs: string[] = [];
let db: Database;
let owner: DrizzleManagedExecutionAdapter;
let legacy: DrizzleExecutionRequestAdapter;
let ledger: DrizzleGraphRunAdapter;
async function seed(): Promise<ManagedExecutionBinding> {
  const runId = randomUUID();
  runs.push(runId);
  const key = `managed-test:${runId}`;
  keys.push(key);
  await db.insert(graphRuns).values({
    runId,
    graphId: "langgraph:mission",
    runKind: "user_immediate",
    requestedBy: actor,
  });
  const binding = {
    idempotencyKey: key,
    requestHash: hash(key),
    runId,
    audience: {
      actorUserId: actor,
      billingAccountId: accountId,
      graphId: "langgraph:mission",
      executionGrantId: null,
    },
  };
  await legacy.createPendingRequest(key, binding.requestHash, runId, null);
  return binding;
}
async function claim(
  binding: ManagedExecutionBinding
): Promise<ManagedExecutionClaim> {
  const result = await owner.acquire(binding, 60_000);
  expect(result.status).toBe("claimed");
  if (result.status !== "claimed") throw new Error("missing claim");
  return result.claim;
}
const resultFor = (c: ManagedExecutionClaim): CanonicalRunResult => ({
  version: 1,
  audience: c.binding.audience,
  runId: c.binding.runId,
  traceId: "trace",
  ok: true,
  structuredOutput: {
    version: 1,
    runId: c.binding.runId,
    status: "accepted",
    proposal: { goal: "goal-1" },
  },
});
describe("managed graph execution transaction", () => {
  beforeAll(async () => {
    db = getSeedDb();
    await db.insert(users).values([{ id: actor }, { id: otherActor }]);
    await db
      .insert(billingAccounts)
      .values({ id: accountId, ownerUserId: actor, balanceCredits: 0n });
    owner = new DrizzleManagedExecutionAdapter(db, getAppDb());
    legacy = new DrizzleExecutionRequestAdapter(db);
    ledger = new DrizzleGraphRunAdapter(db);
  });
  afterAll(async () => {
    if (keys.length)
      await db
        .delete(executionRequests)
        .where(inArray(executionRequests.idempotencyKey, keys));
    if (runs.length)
      await db.delete(graphRuns).where(inArray(graphRuns.runId, runs));
    if (scheduleIds.length)
      await db.delete(schedules).where(inArray(schedules.id, scheduleIds));
    if (grantIds.length)
      await db
        .delete(executionGrants)
        .where(inArray(executionGrants.id, grantIds));
    await db.delete(billingAccounts).where(eq(billingAccounts.id, accountId));
    await db.delete(users).where(inArray(users.id, [actor, otherActor]));
  });
  it("simultaneous receiver delivery of one facade reservation executes one claimant", async () => {
    const binding = await seed();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => owner.acquire(binding, 60_000))
    );
    expect(outcomes.filter((x) => x.status === "claimed")).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === "pending")).toHaveLength(7);
  });
  it("adopts the facade reservation through the deployed api:runId transport alias", async () => {
    const facade = await seed();
    await db
      .update(graphRuns)
      .set({ triggerRef: facade.idempotencyKey })
      .where(eq(graphRuns.runId, facade.runId));
    const transport = { ...facade, idempotencyKey: `api:${facade.runId}` };
    const c = await claim(transport);
    expect(c.binding.idempotencyKey).toBe(facade.idempotencyKey);
    await owner.commit(c, { resolve: () => resultFor(c) });
    expect(await owner.acquire(transport, 60_000)).toEqual({
      status: "cached",
      result: resultFor(c),
    });
    expect(await owner.acquire(facade, 60_000)).toEqual({
      status: "cached",
      result: resultFor(c),
    });
    const alias = await db
      .select()
      .from(executionRequests)
      .where(eq(executionRequests.idempotencyKey, transport.idempotencyKey));
    expect(alias).toHaveLength(0);
  });
  it("stale A cannot heartbeat/finalize B; tokenless worker PATCH cannot bypass B", async () => {
    const binding = await seed();
    const a = await claim(binding);
    await db
      .update(executionRequests)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(executionRequests.idempotencyKey, binding.idempotencyKey));
    const b = await claim(binding);
    expect(b.token).not.toBe(a.token);
    expect(await owner.heartbeat(a, 60_000)).toBe(false);
    expect(
      await ledger.markRunCompleted(
        SYSTEM_ACTOR,
        binding.runId,
        "error",
        "late worker"
      )
    ).toEqual({ applied: false, reason: "receiver_owned" });
    await expect(
      legacy.finalizeRequest(binding.idempotencyKey, {
        ok: false,
        errorCode: "internal",
      })
    ).rejects.toThrow("execution_claim_required");
    const [pending] = await db
      .select()
      .from(graphRuns)
      .where(eq(graphRuns.runId, binding.runId));
    expect(pending?.status).toBe("pending");
    expect(await owner.commit(a, { resolve: () => resultFor(a) })).toEqual({
      status: "stale",
    });
    expect(
      (await owner.commit(b, { resolve: () => resultFor(b) })).status
    ).toBe("committed");
    expect(
      await owner.commit(a, {
        resolve: () => {
          throw new Error("must not execute");
        },
      })
    ).toEqual({ status: "stale" });
    const replay = await owner.acquire(binding, 60_000);
    expect(replay).toEqual({ status: "cached", result: resultFor(b) });
  });
  it("checks lease expiry after waiting for the run lock", async () => {
    const binding = await seed();
    const c = await claim(binding);
    let completion: ReturnType<typeof owner.commit> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(graphRuns)
        .where(eq(graphRuns.id, c.graphRunId))
        .for("update");
      completion = owner.commit(c, { resolve: () => resultFor(c) });
      // Change lease while completion is barred from the run row; no wall-clock sleep.
      await db
        .update(executionRequests)
        .set({
          leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
        })
        .where(eq(executionRequests.idempotencyKey, binding.idempotencyKey));
    });
    expect(await completion).toEqual({ status: "stale" });
  });
  it("refuses terminal legacy runs and ambiguous run IDs before claiming", async () => {
    const terminal = await seed();
    await ledger.markRunCompleted(SYSTEM_ACTOR, terminal.runId, "cancelled");
    expect(await owner.acquire(terminal, 60_000)).toEqual({
      status: "unavailable",
    });
    const ambiguous = await seed();
    await db.insert(graphRuns).values({
      runId: ambiguous.runId,
      graphId: ambiguous.audience.graphId,
      requestedBy: actor,
    });
    expect(await owner.acquire(ambiguous, 60_000)).toEqual({
      status: "unavailable",
    });
  });
  it("binds schedule/grant/billing and API thread before first claim or reclaim", async () => {
    const api = await seed();
    expect(
      await owner.acquire({ ...api, stateKey: "foreign-thread" }, 60_000)
    ).toEqual({ status: "denied" });
    expect(
      await owner.acquire(
        { ...api, audience: { ...api.audience, billingAccountId: "foreign" } },
        60_000
      )
    ).toEqual({ status: "denied" });
    const scheduled = await seed();
    const grantId = randomUUID(),
      otherGrant = randomUUID(),
      scheduleId = randomUUID();
    grantIds.push(grantId, otherGrant);
    scheduleIds.push(scheduleId);
    await db.insert(executionGrants).values(
      [grantId, otherGrant].map((id) => ({
        id,
        userId: actor,
        billingAccountId: accountId,
        scopes: [`graph:execute:${scheduled.audience.graphId}`],
      }))
    );
    await db.insert(schedules).values({
      id: scheduleId,
      ownerUserId: actor,
      executionGrantId: grantId,
      graphId: scheduled.audience.graphId,
      input: {},
      cron: "0 * * * *",
      timezone: "UTC",
    });
    const slot = new Date("2026-10-24T01:00:00.000Z");
    const key = `${scheduleId}:${slot.toISOString()}`;
    keys.push(key);
    await db
      .update(graphRuns)
      .set({ scheduleId, scheduledFor: slot })
      .where(eq(graphRuns.runId, scheduled.runId));
    const binding = {
      ...scheduled,
      idempotencyKey: key,
      stateKey: hash(key),
      audience: { ...scheduled.audience, executionGrantId: grantId },
    };
    const wrong = {
      ...binding,
      audience: { ...binding.audience, executionGrantId: otherGrant },
    };
    expect(await owner.acquire(wrong, 60_000)).toEqual({ status: "denied" });
    await claim(binding);
    await db
      .update(executionRequests)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(executionRequests.idempotencyKey, key));
    expect(await owner.acquire(wrong, 60_000)).toEqual({ status: "denied" });
    expect((await owner.acquire(binding, 60_000)).status).toBe("claimed");
  });
  it("concurrent equal semantic inputs have one accepted result and one prior reference", async () => {
    const a = await claim(await seed());
    const b = await claim(await seed());
    const inputKey = hash(randomUUID());
    const results = await Promise.all(
      [a, b].map((c) =>
        owner.commit(c, {
          acceptedInputKey: inputKey,
          resolve: (prior) => canonicalTerminal(resultFor(c), prior, hash),
        })
      )
    );
    const envelopes = results.map((r) =>
      r.status === "stale"
        ? undefined
        : (r.result.structuredOutput as {
            status: string;
            priorResult?: { runId: string };
          })
    );
    expect(envelopes.map((x) => x?.status).sort()).toEqual([
      "accepted",
      "no_op",
    ]);
    const prior = envelopes.find((x) => x?.status === "no_op")?.priorResult;
    expect([a.binding.runId, b.binding.runId]).toContain(prior?.runId);
    const accepted = await db
      .select()
      .from(graphRuns)
      .where(eq(graphRuns.acceptedInputKey, inputKey));
    expect(accepted).toHaveLength(1);
  });
  it("rollback preserves pending ownership; same request returns exact committed result", async () => {
    const binding = await seed();
    const c = await claim(binding);
    await expect(
      owner.commit(c, {
        resolve: () => {
          throw new Error("failed validation");
        },
      })
    ).rejects.toThrow("failed validation");
    const [pending] = await db
      .select()
      .from(executionRequests)
      .where(eq(executionRequests.idempotencyKey, binding.idempotencyKey));
    expect(pending?.ok).toBeNull();
    await owner.commit(c, { resolve: () => resultFor(c) });
    expect(
      await new DrizzleManagedExecutionAdapter(db, getAppDb()).acquire(
        binding,
        60_000
      )
    ).toEqual({ status: "cached", result: resultFor(c) });
    expect(await owner.readOwnedResult(binding.runId, actor)).toEqual(
      resultFor(c)
    );
    expect(await owner.readOwnedResult(binding.runId, otherActor)).toBeNull();
    await expect(
      owner.commit(
        {
          ...c,
          binding: {
            ...binding,
            audience: { ...binding.audience, executionGrantId: "other" },
          },
        },
        { resolve: () => resultFor(c) }
      )
    ).rejects.toThrow("result_binding_mismatch");
    expect(
      await owner.acquire(
        { ...binding, audience: { ...binding.audience, actorUserId: "other" } },
        60_000
      )
    ).toEqual({ status: "denied" });
    expect(
      await owner.acquire(
        {
          ...binding,
          audience: { ...binding.audience, executionGrantId: randomUUID() },
        },
        60_000
      )
    ).toEqual({ status: "denied" });
    expect(await owner.readOwnedResult(binding.runId, otherActor)).toBeNull();
  });
  it("a second key cannot replace one run, and deleted run remains a tombstone", async () => {
    const binding = await seed();
    const c = await claim(binding);
    await owner.commit(c, { resolve: () => resultFor(c) });
    expect(
      await owner.acquire(
        { ...binding, idempotencyKey: `other:${binding.idempotencyKey}` },
        60_000
      )
    ).toEqual({ status: "mismatch" });
    await db.delete(graphRuns).where(eq(graphRuns.runId, binding.runId));
    expect(await owner.acquire(binding, 60_000)).toEqual({
      status: "unavailable",
    });
    const [row] = await db
      .select()
      .from(executionRequests)
      .where(eq(executionRequests.idempotencyKey, binding.idempotencyKey));
    expect(row?.graphRunId).toBeNull();
    expect(row?.ok).toBe(true);
  });
});
