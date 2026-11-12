// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Deadline/cancellation orchestration only. Real advisory/RLS/row-lock semantics are proved by the SQL adopter fixture in CI. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialSql } from "../src/credentials/postgres";
import { maintenanceTick } from "../src/enrollment/maintenance";

function delayedClient(latency: (query: string) => number) {
  const facts = { cancelled: 0, committed: false, rolledBack: false };
  const tag = (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    let rejectQuery!: (error: Error) => void;
    let timer: ReturnType<typeof setTimeout>;
    const result = new Promise<Record<string, unknown>[]>((resolve, reject) => {
      rejectQuery = reject;
      timer = setTimeout(() => resolve(query.includes("FROM candidate") ? [{ id: "lease" }] : []), latency(query));
    });
    return Object.assign(result, { cancel: async () => { facts.cancelled++; clearTimeout(timer); rejectQuery(new Error("cancelled")); } });
  };
  const client = Object.assign(tag, {
    begin: async <T>(fn: (tx: typeof tag) => Promise<T>) => {
      try { const value = await fn(tag); facts.committed = true; return value; }
      catch (error) { facts.rolledBack = true; throw error; }
    },
  }) as unknown as CredentialSql;
  return { client, facts };
}

afterEach(() => vi.useRealTimers());

describe("one cumulative maintenance budget", () => {
  it("includes a slow lease and cancels/rolls back instead of holding a transaction beyond the deadline", async () => {
    vi.useFakeTimers();
    const { client, facts } = delayedClient((q) => q.includes("FROM candidate") ? 3000 : 0);
    const result = maintenanceTick(client);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual({ processed: 0, due: true });
    expect(facts).toEqual({ cancelled: 1, committed: false, rolledBack: true });
  });

  it("includes final bookkeeping after several individually short queries", async () => {
    vi.useFakeTimers();
    const { client, facts } = delayedClient((q) => q.includes("set_config") ? 0 : 600);
    const result = maintenanceTick(client);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual({ processed: 0, due: true });
    expect(facts).toEqual({ cancelled: 1, committed: false, rolledBack: true });
  });

  it("commits a timely empty tick without cancellation", async () => {
    vi.useFakeTimers();
    const { client, facts } = delayedClient(() => 10);
    const result = maintenanceTick(client);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ processed: 0, due: false });
    expect(facts).toEqual({ cancelled: 0, committed: true, rolledBack: false });
  });
});
