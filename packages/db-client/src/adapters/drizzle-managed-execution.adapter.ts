// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@cogni/db-client/drizzle-managed-execution`
 * Purpose: Fenced canonical run custody and atomic semantic-input admission.
 * Scope: Node-owned PostgreSQL transactions; shared policy arrives through a synchronous callback.
 * Invariants: one request per run row; graph then request lock order; current token alone commits; terminal results immutable.
 * Side-effects: database reads/writes only.
 * Links: https://cognidao.org/work/items/task.5340
 * @public
 */
import { randomUUID } from "node:crypto";
import {
  executionRequests,
  graphRuns,
  schedules,
} from "@cogni/db-schema/scheduling";
import {
  type CanonicalRunResult,
  type ManagedAcquireResult,
  type ManagedCommitResult,
  type ManagedExecutionBinding,
  type ManagedExecutionClaim,
  type ManagedExecutionPort,
  readCanonicalResult,
  sameExecutionAudience,
} from "@cogni-dao/graph-execution";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RunRow = typeof graphRuns.$inferSelect;
async function serverNow(tx: Tx): Promise<Date> {
  const rows = await tx.execute<{ now: string }>(
    sql`SELECT clock_timestamp() AS now`
  );
  const row = rows[0];
  if (!row) throw new Error("database_clock_unavailable");
  return new Date(row.now);
}
function leaseDuration(ms: number): number {
  if (!Number.isInteger(ms) || ms < 1 || ms > 300_000)
    throw new Error("invalid_execution_lease");
  return ms;
}
async function ownerMatches(
  tx: Tx,
  run: RunRow,
  actorUserId: string
): Promise<boolean> {
  if (run.requestedBy !== null) return run.requestedBy === actorUserId;
  if (!run.scheduleId) return false;
  const [schedule] = await tx
    .select({ owner: schedules.ownerUserId })
    .from(schedules)
    .where(eq(schedules.id, run.scheduleId));
  return schedule?.owner === actorUserId;
}
function replay(
  run: RunRow,
  binding: ManagedExecutionBinding
): ManagedAcquireResult {
  if (!run.terminalResult) return { status: "unavailable" };
  let result: CanonicalRunResult;
  try {
    result = readCanonicalResult(run.terminalResult);
  } catch {
    return { status: "unavailable" };
  }
  if (
    result.runId !== binding.runId ||
    !sameExecutionAudience(result.audience, binding.audience)
  )
    return { status: "denied" };
  return { status: "cached", result };
}
export class DrizzleManagedExecutionAdapter implements ManagedExecutionPort {
  constructor(private readonly db: Database) {}

  async acquire(
    binding: ManagedExecutionBinding,
    leaseMs: number
  ): Promise<ManagedAcquireResult> {
    leaseDuration(leaseMs);
    return this.db.transaction(async (tx) => {
      const runs = await tx
        .select()
        .from(graphRuns)
        .where(eq(graphRuns.runId, binding.runId))
        .for("update");
      const run = runs[0];
      if (runs.length !== 1 || !run) return { status: "unavailable" };
      if (
        run.graphId !== binding.audience.graphId ||
        !(await ownerMatches(tx, run, binding.audience.actorUserId))
      )
        return { status: "denied" };
      const [bound] = await tx
        .select()
        .from(executionRequests)
        .where(eq(executionRequests.graphRunId, run.id));
      if (bound && bound.idempotencyKey !== binding.idempotencyKey)
        return { status: "mismatch" };
      await tx
        .insert(executionRequests)
        .values({
          idempotencyKey: binding.idempotencyKey,
          requestHash: binding.requestHash,
          runId: binding.runId,
          traceId: null,
          ok: null,
        })
        .onConflictDoNothing();
      const [request] = await tx
        .select()
        .from(executionRequests)
        .where(eq(executionRequests.idempotencyKey, binding.idempotencyKey))
        .for("update");
      if (
        !request ||
        request.requestHash !== binding.requestHash ||
        request.runId !== binding.runId ||
        (request.graphRunId !== null && request.graphRunId !== run.id)
      )
        return { status: "mismatch" };
      if (request.ok !== null)
        return request.graphRunId === run.id
          ? replay(run, binding)
          : { status: "unavailable" };
      // SET NULL after deletion leaves the claim token as a tombstone. Never adopt it again.
      if (request.claimToken !== null && request.graphRunId === null)
        return { status: "unavailable" };
      if (run.terminalResult) return replay(run, binding);
      if (!["pending", "running", "timeout"].includes(run.status))
        return { status: "unavailable" };
      const now = await serverNow(tx);
      if (request.leaseExpiresAt && request.leaseExpiresAt > now)
        return { status: "pending" };
      const token = randomUUID();
      await tx
        .update(executionRequests)
        .set({
          graphRunId: run.id,
          claimToken: token,
          updatedAt: now,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        })
        .where(eq(executionRequests.idempotencyKey, binding.idempotencyKey));
      return {
        status: "claimed",
        claim: { binding, graphRunId: run.id, token },
      };
    });
  }

  async heartbeat(
    claim: ManagedExecutionClaim,
    leaseMs: number
  ): Promise<boolean> {
    leaseDuration(leaseMs);
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(graphRuns)
        .where(eq(graphRuns.id, claim.graphRunId))
        .for("update");
      if (!run || run.terminalResult) return false;
      const [request] = await tx
        .select()
        .from(executionRequests)
        .where(
          eq(executionRequests.idempotencyKey, claim.binding.idempotencyKey)
        )
        .for("update");
      const now = await serverNow(tx);
      if (
        !request ||
        request.graphRunId !== run.id ||
        request.requestHash !== claim.binding.requestHash ||
        request.claimToken !== claim.token ||
        request.ok !== null ||
        !request.leaseExpiresAt ||
        request.leaseExpiresAt <= now
      )
        return false;
      await tx
        .update(executionRequests)
        .set({
          updatedAt: now,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
        })
        .where(eq(executionRequests.idempotencyKey, request.idempotencyKey));
      return true;
    });
  }

  async commit(
    claim: ManagedExecutionClaim,
    input: {
      acceptedInputKey?: string;
      resolve: (prior?: CanonicalRunResult) => CanonicalRunResult;
    }
  ): Promise<ManagedCommitResult> {
    if (
      input.acceptedInputKey &&
      !/^[a-f0-9]{64}$/.test(input.acceptedInputKey)
    )
      throw new Error("invalid_accepted_input_key");
    return this.db.transaction(async (tx) => {
      if (input.acceptedInputKey)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.acceptedInputKey}, 0))`
        );
      const [run] = await tx
        .select()
        .from(graphRuns)
        .where(eq(graphRuns.id, claim.graphRunId))
        .for("update");
      if (!run) return { status: "stale" };
      const [request] = await tx
        .select()
        .from(executionRequests)
        .where(
          eq(executionRequests.idempotencyKey, claim.binding.idempotencyKey)
        )
        .for("update");
      if (
        !request ||
        request.graphRunId !== run.id ||
        request.requestHash !== claim.binding.requestHash ||
        request.claimToken !== claim.token
      )
        return { status: "stale" };
      if (run.terminalResult) {
        const cached = replay(run, claim.binding);
        if (cached.status !== "cached")
          throw new Error("result_binding_mismatch");
        return cached;
      }
      const now = await serverNow(tx);
      if (
        request.ok !== null ||
        !request.leaseExpiresAt ||
        request.leaseExpiresAt <= now
      )
        return { status: "stale" };
      let prior: CanonicalRunResult | undefined;
      if (input.acceptedInputKey) {
        const [accepted] = await tx
          .select({ result: graphRuns.terminalResult })
          .from(graphRuns)
          .where(eq(graphRuns.acceptedInputKey, input.acceptedInputKey));
        if (accepted) prior = readCanonicalResult(accepted.result);
      }
      const result = readCanonicalResult(input.resolve(prior));
      if (
        result.runId !== run.runId ||
        result.audience.graphId !== run.graphId ||
        !sameExecutionAudience(result.audience, claim.binding.audience)
      )
        throw new Error("result_binding_mismatch");
      if (
        input.acceptedInputKey &&
        (!result.ok ||
          !result.structuredOutput ||
          typeof result.structuredOutput !== "object" ||
          (result.structuredOutput as { status?: unknown }).status !==
            (prior ? "no_op" : "accepted"))
      )
        throw new Error("invalid_admission_result");
      await tx
        .update(graphRuns)
        .set({
          terminalResult: result,
          acceptedInputKey: prior ? null : (input.acceptedInputKey ?? null),
          status: result.ok ? "success" : "error",
          completedAt: now,
          errorCode: result.errorCode ?? null,
          langfuseTraceId: result.traceId,
        })
        .where(eq(graphRuns.id, run.id));
      await tx
        .update(executionRequests)
        .set({
          ok: result.ok,
          errorCode: result.errorCode ?? null,
          traceId: result.traceId,
          updatedAt: now,
          leaseExpiresAt: null,
        })
        .where(eq(executionRequests.idempotencyKey, request.idempotencyKey));
      return { status: "committed", result };
    });
  }

  async readOwnedResult(
    runId: string,
    actorUserId: string
  ): Promise<CanonicalRunResult | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(graphRuns)
        .where(
          and(
            eq(graphRuns.runId, runId),
            eq(graphRuns.requestedBy, actorUserId)
          )
        );
      if (rows.length !== 1 || !rows[0]?.terminalResult) return null;
      let result: CanonicalRunResult;
      try {
        result = readCanonicalResult(rows[0].terminalResult);
      } catch {
        return null;
      }
      return result.runId === runId &&
        result.audience.graphId === rows[0].graphId &&
        result.audience.actorUserId === actorUserId
        ? result
        : null;
    });
  }
}
