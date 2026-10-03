// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proves in-process Dolt operations wait FIFO instead of failing on overlap. */

import { toWorkItemId } from "@cogni/work-items";
import { describe, expect, it } from "vitest";

import {
  DoltgresWorkItemAdapter,
  WorkItemsBusyError,
} from "../../src/adapters/doltgres/adapter.js";
import { makeFakeDoltgresSql } from "./fake-doltgres-sql.js";

const row = {
  id: "task.0001",
  type: "task",
  title: "queued",
  status: "needs_implement",
  node: "shared",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  revision: 1,
  deploy_verified: false,
  created_by_principal_id: "principal-1",
  claimed_by_run: "run-1",
  claim_owner_principal_id: "principal-1",
  claimed_at: "2026-10-03T00:00:00.000Z",
  claim_expires_at: "2026-10-03T00:05:00.000Z",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};

function makeBlockedHeartbeatAdapter(queueWaitMs: number) {
  const queries: string[] = [];
  let releaseHeartbeat: (rows: ReadonlyArray<Record<string, unknown>>) => void =
    () => undefined;
  const heartbeatGate = new Promise<ReadonlyArray<Record<string, unknown>>>(
    (resolve) => {
      releaseHeartbeat = resolve;
    }
  );
  const sql = makeFakeDoltgresSql((query) => {
    if (
      query.startsWith("UPDATE work_items SET claim_expires_at = NOW()")
    ) {
      return heartbeatGate;
    }
    if (query.includes("FROM work_items")) {
      return [{ ...row, claim_active: true }];
    }
    return [];
  }, queries);
  return {
    adapter: new DoltgresWorkItemAdapter(sql, { queueWaitMs }),
    queries,
    releaseHeartbeat: () => releaseHeartbeat([{ ...row, claim_active: true }]),
  };
}

async function waitForHeartbeatDml(queries: string[]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      queries.some((query) =>
        query.startsWith("UPDATE work_items SET claim_expires_at = NOW()")
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("heartbeat did not reach its DML gate");
}

describe("DoltgresWorkItemAdapter operation queue", () => {
  it("queues a concurrent read behind heartbeat and serves both", async () => {
    const { adapter, queries, releaseHeartbeat } =
      makeBlockedHeartbeatAdapter(100);
    const heartbeat = adapter.heartbeat({
      id: toWorkItemId(row.id),
      runId: "run-1",
      command: "/implement:heartbeat",
      principalId: "principal-1",
    });
    await waitForHeartbeatDml(queries);

    const list = adapter.list();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      queries.some(
        (query) => query.includes("FROM work_items") && query.includes("ORDER BY")
      )
    ).toBe(false);

    releaseHeartbeat();
    await expect(heartbeat).resolves.toMatchObject({ id: "task.0001" });
    await expect(list).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "task.0001" })],
    });
  });

  it("returns bounded busy and skips an abandoned queue ticket", async () => {
    const { adapter, queries, releaseHeartbeat } = makeBlockedHeartbeatAdapter(5);
    const heartbeat = adapter.heartbeat({
      id: toWorkItemId(row.id),
      runId: "run-1",
      principalId: "principal-1",
    });
    await waitForHeartbeatDml(queries);

    await expect(adapter.get(toWorkItemId(row.id))).rejects.toBeInstanceOf(
      WorkItemsBusyError
    );
    releaseHeartbeat();
    await heartbeat;
    await expect(adapter.get(toWorkItemId(row.id))).resolves.toMatchObject({
      id: "task.0001",
    });
  });
});
