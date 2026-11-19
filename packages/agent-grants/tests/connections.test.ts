// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  applyConnection,
  assertConnectionAdmits,
  CONNECT_SCOPE,
  ConnectionRefusedError,
  connectionRefusalFor,
  decideConnection,
  isConnectionRefusedError,
  MAX_SEQ_STEP,
  parseConnectClaims,
  viewOf,
} from "../src";
import { NODE_CONNECT_SERVICE, type VerifiedServiceAssertion } from "../src/service-auth";
import { memoryConnectionStore } from "./connections-store";

const HOME = "https://toks5-test.cognidao.org";

const assertion = (over: Partial<VerifiedServiceAssertion> & { claims?: Record<string, string | number | boolean> } = {}): VerifiedServiceAssertion => ({
  ok: true,
  issuer: HOME,
  service: NODE_CONNECT_SERVICE,
  clientId: `${HOME}#${NODE_CONNECT_SERVICE}`,
  scope: CONNECT_SCOPE,
  jti: crypto.randomUUID(),
  claims: { act: "connect", cap: 1000, seq: 1 },
  ...over,
});

const connect = (cap: number, seq: number) => assertion({ claims: { act: "connect", cap, seq } });
const disconnect = (seq: number) => assertion({ claims: { act: "disconnect", cap: 0, seq } });
const SERVICES = ["node-ai", "git-review", NODE_CONNECT_SERVICE];

describe("parseConnectClaims", () => {
  it("accepts act connect or disconnect with an integer cap of at least 0 and an integer seq of at least 1", () => {
    expect(parseConnectClaims({ act: "connect", cap: 0, seq: 1 })).toEqual({ act: "connect", cap: 0, seq: 1 });
    expect(parseConnectClaims({ act: "disconnect", cap: 10, seq: 99 })).toEqual({ act: "disconnect", cap: 10, seq: 99 });
  });

  it("refuses a missing, mistyped or out-of-range claim", () => {
    for (const claims of [{}, { act: "grant", cap: 1, seq: 1 }, { act: "connect", cap: -1, seq: 1 }, { act: "connect", cap: 1.5, seq: 1 }, { act: "connect", cap: "5", seq: 1 }, { act: "connect", cap: 1, seq: 0 }, { act: "connect", cap: 1 }, { act: "connect", seq: 1 }])
      expect(parseConnectClaims(claims as never)).toBeNull();
  });
});

describe("applyConnection", () => {
  it("only service node-connect with the connect scope and well-formed claims reaches the store", async () => {
    const store = memoryConnectionStore();
    expect(await applyConnection(store, { assertion: assertion({ service: "node-ai" }), services: SERVICES })).toEqual({ ok: false, code: "wrong_service" });
    expect(await applyConnection(store, { assertion: assertion({ scope: "knowledge:read" }), services: SERVICES })).toEqual({ ok: false, code: "wrong_scope" });
    expect(await applyConnection(store, { assertion: assertion({ claims: { act: "connect", cap: -5, seq: 1 } }), services: SERVICES })).toEqual({ ok: false, code: "invalid_claims" });
    expect(store.rows.size).toBe(0);
  });

  it("a connect creates the one record, binds only the service principals that already exist (never node-connect), and a second connect reuses the record", async () => {
    const store = memoryConnectionStore();
    // node-ai asked before this connect; git-review has not asked.
    store.principals.add(`${HOME}#node-ai`);
    const first = await applyConnection(store, { assertion: connect(1000, 1), services: SERVICES });
    expect(first).toMatchObject({ ok: true, act: "connect", record: { issuer: HOME, status: "connected", cap: 1000, seq: 1, suspended: false } });
    expect([...store.bound.keys()]).toEqual([`${HOME}#node-ai`]);
    expect(await store.bindService({ issuer: HOME, subjectUserId: `${HOME}#git-review` })).toBe(true);
    const second = await applyConnection(store, { assertion: connect(2500, 2), services: SERVICES });
    expect(second).toMatchObject({ ok: true, record: { cap: 2500, seq: 2 } });
    expect(store.rows.size).toBe(1);
    expect(first.ok && second.ok && first.record.orgUserId === second.record.orgUserId && first.record.billingAccountId === second.record.billingAccountId).toBe(true);
  });

  it("a connect creates NO service principal and binds nothing: the customer's AI must still ask and wait for an admin", async () => {
    const store = memoryConnectionStore();
    expect(await applyConnection(store, { assertion: connect(1000, 1), services: SERVICES })).toMatchObject({ ok: true });
    expect(store.principals.size).toBe(0);
    expect(store.bound.size).toBe(0);
  });

  it("a seq more than MAX_SEQ_STEP above the stored one (or above 1 million on a first connect) is refused and changes nothing; the admin's reset puts the record back to 1", async () => {
    const store = memoryConnectionStore();
    expect(await applyConnection(store, { assertion: connect(1, MAX_SEQ_STEP + 1), services: SERVICES })).toEqual({ ok: false, code: "seq_jump", seq: 0 });
    expect(store.rows.size).toBe(0);
    const first = await applyConnection(store, { assertion: connect(1000, MAX_SEQ_STEP), services: SERVICES });
    if (!first.ok) throw new Error("connect failed");
    expect(await applyConnection(store, { assertion: connect(1000, 2 * MAX_SEQ_STEP + 1), services: SERVICES })).toEqual({ ok: false, code: "seq_jump", seq: MAX_SEQ_STEP });
    expect(await applyConnection(store, { assertion: connect(1000, 2 * MAX_SEQ_STEP), services: SERVICES })).toMatchObject({ ok: true });
    // A bricked record: the admin resets the stored seq, and the customer's next seq lands.
    expect(await store.resetSeq(first.record.orgUserId)).toBe(true);
    expect(await applyConnection(store, { assertion: connect(1000, 2), services: SERVICES })).toMatchObject({ ok: true, record: { seq: 2, cap: 1000 } });
    expect(await store.resetSeq("nobody")).toBe(false);
  });

  it("refuses a seq at or below the stored one and changes nothing (CONNECT_IS_ORDERED)", async () => {
    const store = memoryConnectionStore();
    await applyConnection(store, { assertion: connect(1000, 5), services: SERVICES });
    expect(await applyConnection(store, { assertion: connect(9999, 5), services: SERVICES })).toEqual({ ok: false, code: "stale_seq", seq: 5 });
    expect(await applyConnection(store, { assertion: connect(9999, 4), services: SERVICES })).toMatchObject({ ok: false, code: "stale_seq" });
    expect(await applyConnection(store, { assertion: disconnect(3), services: SERVICES })).toMatchObject({ ok: false, code: "stale_seq" });
    const [row] = [...store.rows.values()];
    expect(row?.record).toMatchObject({ cap: 1000, seq: 5, status: "connected" });
  });

  it("a replayed connect (the same signed body again) leaves the cap unchanged after a newer connect", async () => {
    const store = memoryConnectionStore();
    const original = connect(1000, 1);
    await applyConnection(store, { assertion: original, services: SERVICES });
    await applyConnection(store, { assertion: connect(7000, 2), services: SERVICES });
    // The attacker replays the first signed body (its jti is refused by the durable store; even with a fresh jti its seq is stale).
    expect(await applyConnection(store, { assertion: { ...original, jti: crypto.randomUUID() }, services: SERVICES })).toMatchObject({ ok: false, code: "stale_seq" });
    expect([...store.rows.values()][0]?.record.cap).toBe(7000);
  });

  it("Suspend is sticky: a higher-seq connect keeps it, a disconnect then a reconnect keeps it, and only the provider's Resume clears it", async () => {
    const store = memoryConnectionStore();
    const first = await applyConnection(store, { assertion: connect(1000, 1), services: SERVICES });
    if (!first.ok) throw new Error("connect failed");
    await store.setSuspended(first.record.orgUserId, true);

    const again = await applyConnection(store, { assertion: connect(5000, 2), services: SERVICES });
    expect(again).toMatchObject({ ok: true, record: { suspended: true, cap: 5000, status: "connected" } });
    await applyConnection(store, { assertion: disconnect(3), services: SERVICES });
    const back = await applyConnection(store, { assertion: connect(5000, 4), services: SERVICES });
    expect(back).toMatchObject({ ok: true, record: { suspended: true } });

    store.credit(first.record.orgUserId, 100);
    expect(await connectionRefusalFor(store, first.record.billingAccountId)).toBe("connection_suspended");

    expect(await store.setSuspended(first.record.orgUserId, false)).toBe(true);
    expect(await connectionRefusalFor(store, first.record.billingAccountId)).toBeNull();
  });

  it("a disconnect is a tombstone that keeps the cap; the very next run is refused, and a later connect replaces the cap and keeps the count", async () => {
    const store = memoryConnectionStore();
    const first = await applyConnection(store, { assertion: connect(1000, 1), services: SERVICES });
    if (!first.ok) throw new Error("connect failed");
    const account = first.record.billingAccountId;
    store.credit(first.record.orgUserId, 5000);
    store.debit(first.record.orgUserId, 400);
    expect(await connectionRefusalFor(store, account)).toBeNull();

    const gone = await applyConnection(store, { assertion: disconnect(2), services: SERVICES });
    expect(gone).toMatchObject({ ok: true, act: "disconnect", record: { status: "disconnected", cap: 1000, seq: 2 } });
    expect(await connectionRefusalFor(store, account)).toBe("connection_disconnected");

    await applyConnection(store, { assertion: connect(600, 3), services: SERVICES });
    // The cap is replaced (600) and the 400 already spent still counts: 400 < 600 admits, 600 would not.
    expect(await connectionRefusalFor(store, account)).toBeNull();
    store.debit(first.record.orgUserId, 200);
    expect(await connectionRefusalFor(store, account)).toBe("connection_cap_reached");
  });
});

describe("the run gate", () => {
  const live = { status: "connected" as const, suspended: false, cap: 1000, balance: 50, debits: 0 };

  it("admits only while the allowance is above zero AND the cumulative debits are below the cap", () => {
    expect(decideConnection(live)).toBeNull();
    expect(decideConnection({ ...live, debits: 999 })).toBeNull();
  });

  it("the cap refuses a run: debits at or above the cap", () => {
    expect(decideConnection({ ...live, debits: 1000 })).toBe("connection_cap_reached");
    expect(decideConnection({ ...live, debits: 1500 })).toBe("connection_cap_reached");
    expect(decideConnection({ ...live, cap: 0 })).toBe("connection_cap_reached");
  });

  it("a zero or negative balance refuses a run, even far under the cap", () => {
    expect(decideConnection({ ...live, balance: 0 })).toBe("connection_allowance_empty");
    expect(decideConnection({ ...live, balance: -3 })).toBe("connection_allowance_empty");
  });

  it("suspended wins over disconnected, which wins over money", () => {
    expect(decideConnection({ ...live, suspended: true, status: "disconnected", balance: 0 })).toBe("connection_suspended");
    expect(decideConnection({ ...live, status: "disconnected", balance: 0, debits: 5000 })).toBe("connection_disconnected");
    expect(decideConnection({ ...live, balance: 0, debits: 5000 })).toBe("connection_allowance_empty");
  });

  it("an account that is not a connection record is never refused here (an ordinary payer)", async () => {
    const store = memoryConnectionStore();
    expect(await connectionRefusalFor(store, "acct-someone")).toBeNull();
    await expect(assertConnectionAdmits(store, "acct-someone")).resolves.toBeUndefined();
  });

  it("assertConnectionAdmits throws a typed refusal with the plain code, read live on every call", async () => {
    const store = memoryConnectionStore();
    const c = await applyConnection(store, { assertion: connect(100, 1), services: SERVICES });
    if (!c.ok) throw new Error("connect failed");
    const refused = await assertConnectionAdmits(store, c.record.billingAccountId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectionRefusedError);
    expect(isConnectionRefusedError(refused)).toBe(true);
    expect((refused as ConnectionRefusedError).code).toBe("connection_allowance_empty");
    store.credit(c.record.orgUserId, 10);
    await expect(assertConnectionAdmits(store, c.record.billingAccountId)).resolves.toBeUndefined();
    expect(isConnectionRefusedError(new Error("connection_cap_reached"))).toBe(false);
  });
});

describe("the provider's list", () => {
  it("shows one display status (suspended wins), the allowance, debits, cap and last call; pages by issuer with one extra row", async () => {
    const store = memoryConnectionStore();
    for (const [i, host] of ["a", "b", "c"].entries()) await applyConnection(store, { assertion: assertion({ issuer: `https://${host}.example.org`, claims: { act: "connect", cap: 100 * (i + 1), seq: 1 } }), services: SERVICES });
    const [a] = await store.list({ limit: 1, after: null });
    if (!a) throw new Error("no rows");
    await store.setSuspended(a.orgUserId, true);
    store.credit(a.orgUserId, 40);
    store.debit(a.orgUserId, 15);
    const page = await store.list({ limit: 2, after: null });
    expect(page).toHaveLength(3); // limit + 1: there is a next page
    expect(viewOf(page[0] as never)).toEqual({ orgUserId: a.orgUserId, issuer: "https://a.example.org", status: "suspended", allowance: 25, debits: 15, cap: 100, lastCallAt: "2026-11-18T00:00:00.000Z" });
    const next = await store.list({ limit: 2, after: "https://b.example.org" });
    expect(next.map((r) => r.issuer)).toEqual(["https://c.example.org"]);
  });
});
