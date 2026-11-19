// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/connections.int.test`
 * Purpose: Connect from home (story.0038, agent-grants 0.10.0, migration 0048) against real Postgres. The provider's side end to end below the route: a signed connect is verified by the
 *   real verifier over the DURABLE replay store, applied by the real connection store, and gates a run by the real standing query.
 * Scope: Each test uses its own random issuer, so tests never share a record. The replay store and the connection store are rebuilt between "process A" and "process B" over the same database,
 *   which is what a restart or a second replica is.
 * Invariants: DURABLE_REPLAY (a replayed `jti` is refused after a restart; an expired row is taken over and pruned), CONNECT_IS_ORDERED (a stale `seq` after a restart is refused and the
 *   cap is unchanged), SUSPEND_IS_STICKY (survives a higher-seq connect, a disconnect and a reconnect; only Resume clears it), TRUSTED_HOMES_ONLY (an unlisted issuer or service creates no
 *   record, no org, no principal), ALLOWANCE_BOUNDS_COST (a zero balance and a reached cap each refuse a run; a new connect replaces the cap and keeps the count),
 *   ONE_RECORD_PER_ISSUER (an existing service principal of the issuer is billed to the one record, a connect creates none, the ask binds the rest), SEQ_STEP_IS_BOUNDED (+ the admin reset), OUTBOUND_SEQ (this node's own side), ALLOWANCE_IS_ONE_LEDGER_ROW (idempotent, race-safe through the real accounts adapter).
 * Side-effects: IO (testcontainers Postgres; rows are not rolled back because the replay store and the accounts adapter use their own connections)
 */

import { randomUUID } from "node:crypto";
import {
  applyConnection,
  assertConnectionAdmits,
  CONNECT_SCOPE,
  type ConnectOutcome,
  createConnectSender,
  createPostgresConnectionStore,
  createPostgresOutboundConnectionStore,
  createPostgresPayerBindingStore,
  isConnectionRefusedError,
  MAX_SEQ_STEP,
  payerFor,
  type SqlTag,
} from "@cogni/agent-grants";
import {
  createPostgresReplayStore,
  createServiceAssertionSignerFromSeed,
  createServiceAssertionVerifier,
  ensureServicePrincipal,
  findServicePrincipal,
  NODE_CONNECT_SERVICE,
  servicePrincipalId,
  type ServiceAssertionSigner,
  type TrustedHome,
} from "@cogni/agent-grants/service-auth";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import type { AgentAuthoritySql } from "@/bootstrap/agent-authority";
import { createConnections } from "@/bootstrap/connections";

const NODE = "provider-node";
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const logger = () => {
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => log };
  return log as never;
};

describe("connect from home (real Postgres)", () => {
  let service: Sql;
  let sql: AgentAuthoritySql;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 4 });
    sql = service as unknown as AgentAuthoritySql;
  });
  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  /** A customer: a signer for its own origin, and a provider verifier that trusts it (a fresh process each call, over the one database). */
  async function customer(opts: { listed?: boolean; services?: string[] } = {}) {
    const issuer = `https://home-${randomUUID()}.example.org`;
    const signer: ServiceAssertionSigner = await createServiceAssertionSignerFromSeed({ issuer, seedHex: SEED });
    const home: TrustedHome = { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, services: opts.services ?? ["node-ai", NODE_CONNECT_SERVICE] };
    const freshProcess = () =>
      createServiceAssertionVerifier({
        selfNodeId: NODE,
        trustedHomes: opts.listed === false ? [] : [home],
        fetchJwks: async () => signer.jwks(),
        replay: createPostgresReplayStore(sql as unknown as SqlTag),
      });
    const sign = (claims: { act: "connect" | "disconnect"; cap: number; seq: number }) =>
      signer.sign({ service: NODE_CONNECT_SERVICE, audienceNodeId: NODE, scope: CONNECT_SCOPE, claims });
    /** Verify then apply, as the route does, in a brand-new "process" (new verifier, new replay store, new connection store). */
    const send = async (token: string): Promise<{ verified: false; code: string } | { verified: true; outcome: ConnectOutcome }> => {
      const result = await freshProcess().verify(token);
      if (!result.ok) return { verified: false, code: result.code };
      const outcome = await sql.begin((tx) => applyConnection(createPostgresConnectionStore(tx), { assertion: result, services: home.services }));
      return { verified: true, outcome };
    };
    return { issuer, signer, home, sign, send, freshProcess };
  }

  const row = async (issuer: string) =>
    (await sql`SELECT org_user_id, billing_account_id, status, suspended, cap::text AS cap, seq::text AS seq FROM org_connections WHERE issuer = ${issuer}`)[0];

  /** Money for the gate: a balance and a charge receipt, as the node's ledger would write them. */
  const setBalance = async (billingAccountId: string, credits: number) => {
    await sql`UPDATE billing_accounts SET balance_credits = ${credits} WHERE id = ${billingAccountId}`;
  };
  const charge = async (billingAccountId: string, credits: number) => {
    const key = (await sql`SELECT id FROM virtual_keys WHERE billing_account_id = ${billingAccountId} AND is_default = true LIMIT 1`)[0]?.id as string;
    await sql`
      INSERT INTO charge_receipts (billing_account_id, virtual_key_id, run_id, attempt, charged_credits, provenance, charge_reason, source_system, source_reference, receipt_kind)
      VALUES (${billingAccountId}, ${key}, ${randomUUID()}, 0, ${credits}, 'response', 'llm_usage', 'litellm', ${randomUUID()}, 'llm')`;
  };
  const gate = async (billingAccountId: string): Promise<string | null> => {
    try {
      await assertConnectionAdmits(createPostgresConnectionStore(sql as unknown as SqlTag), billingAccountId);
      return null;
    } catch (error) {
      if (isConnectionRefusedError(error)) return error.code;
      throw error;
    }
  };

  it("a stale seq is refused after a restart, and the replayed body's jti is refused by the durable store; the cap stays", async () => {
    const c = await customer();
    const first = await c.sign({ act: "connect", cap: 1000, seq: 5 });
    expect(await c.send(first)).toMatchObject({ verified: true, outcome: { ok: true, record: { cap: 1000, seq: 5, status: "connected" } } });

    // A restart: a new verifier and a new replay store over the same table. The very same signed body is a replay.
    expect(await c.send(first)).toEqual({ verified: false, code: "replayed" });

    // A fresh jti with an older seq verifies, and is refused as stale with the stored seq; nothing changes.
    const older = await c.sign({ act: "connect", cap: 999_999, seq: 4 });
    expect(await c.send(older)).toMatchObject({ verified: true, outcome: { ok: false, code: "stale_seq", seq: 5 } });
    const same = await c.sign({ act: "connect", cap: 999_999, seq: 5 });
    expect(await c.send(same)).toMatchObject({ verified: true, outcome: { ok: false, code: "stale_seq" } });
    expect(await row(c.issuer)).toMatchObject({ cap: "1000", seq: "5", status: "connected" });

    // A higher seq replaces the cap.
    expect(await c.send(await c.sign({ act: "connect", cap: 2500, seq: 6 }))).toMatchObject({ verified: true, outcome: { ok: true, record: { cap: 2500, seq: 6 } } });
    expect(await row(c.issuer)).toMatchObject({ cap: "2500", seq: "6" });
  });

  it("the replay store takes over an expired row and prunes expired rows, and a live jti is a replay", async () => {
    const store = createPostgresReplayStore(sql as unknown as SqlTag);
    const stale = `replay-${randomUUID()}`;
    const other = `replay-${randomUUID()}`;
    await sql`INSERT INTO service_assertion_jtis (jti, expires_at) VALUES (${stale}, now() - interval '1 hour'), (${other}, now() - interval '2 hours')`;
    // An expired row for the same jti is not a replay: it is taken over.
    expect(await store.seen(stale, new Date(Date.now() + 120_000))).toBe(false);
    expect(await store.seen(stale, new Date(Date.now() + 120_000))).toBe(true);
    // The other expired row was pruned by that call (PRUNED_AFTER_EXP).
    expect(await sql`SELECT 1 FROM service_assertion_jtis WHERE jti = ${other}`).toHaveLength(0);
  });

  it("Suspend is sticky: it survives a higher-seq connect, a disconnect and a reconnect, and only the provider's Resume clears it", async () => {
    const c = await customer();
    await c.send(await c.sign({ act: "connect", cap: 1000, seq: 1 }));
    const record = await row(c.issuer);
    const orgUserId = record?.org_user_id as string;
    const account = record?.billing_account_id as string;
    await setBalance(account, 1_000);
    expect(await gate(account)).toBeNull();

    expect(await createPostgresConnectionStore(sql as unknown as SqlTag).setSuspended(orgUserId, true)).toBe(true);
    expect(await gate(account)).toBe("connection_suspended");

    await c.send(await c.sign({ act: "connect", cap: 9000, seq: 2 }));
    expect(await row(c.issuer)).toMatchObject({ suspended: true, cap: "9000", status: "connected" });
    expect(await gate(account)).toBe("connection_suspended");
    await c.send(await c.sign({ act: "disconnect", cap: 0, seq: 3 }));
    await c.send(await c.sign({ act: "connect", cap: 9000, seq: 4 }));
    expect(await row(c.issuer)).toMatchObject({ suspended: true });
    expect(await gate(account)).toBe("connection_suspended");

    await createPostgresConnectionStore(sql as unknown as SqlTag).setSuspended(orgUserId, false);
    expect(await gate(account)).toBeNull();
  });

  it("an unlisted issuer, or a listed one whose entry lacks node-connect, creates no record, no org and no principal", async () => {
    const unlisted = await customer({ listed: false });
    expect(await unlisted.send(await unlisted.sign({ act: "connect", cap: 1000, seq: 1 }))).toEqual({ verified: false, code: "untrusted_issuer" });
    const noService = await customer({ services: ["node-ai"] });
    expect(await noService.send(await noService.sign({ act: "connect", cap: 1000, seq: 1 }))).toEqual({ verified: false, code: "service_not_allowed" });
    for (const issuer of [unlisted.issuer, noService.issuer]) {
      expect(await row(issuer)).toBeUndefined();
      expect(await sql`SELECT 1 FROM agent_principals WHERE kind = 'org' AND owner_source_kind = 'issuer' AND owner_source_ref = ${issuer}`).toHaveLength(0);
    }
  });

  it("a connect creates NO service principal: the customer's AI still has none (so its first read is 401 and it asks); an existing principal is bound, and a service that asks later is bound by the ask", async () => {
    const c = await customer({ services: ["node-ai", "git-review", NODE_CONNECT_SERVICE] });
    // node-ai asked before this connect; git-review has not.
    await sql.begin((tx) => ensureServicePrincipal(tx as unknown as SqlTag, { issuer: c.issuer, service: "node-ai" }));
    await c.send(await c.sign({ act: "connect", cap: 1000, seq: 1 }));
    const account = (await row(c.issuer))?.billing_account_id as string;
    const payer = createPostgresPayerBindingStore(sql as unknown as SqlTag);
    expect(await payerFor(payer, await servicePrincipalId({ issuer: c.issuer, service: "node-ai" }))).toBe(account);
    for (const svc of ["git-review", NODE_CONNECT_SERVICE]) {
      // No users row, no principal: `servicePrincipalOf` answers null, so a signed read is 401 and the AI's own ask follows.
      expect(await findServicePrincipal(sql as unknown as SqlTag, { issuer: c.issuer, service: svc }), svc).toBeNull();
      expect(await sql`SELECT 1 FROM users WHERE id = ${await servicePrincipalId({ issuer: c.issuer, service: svc })}`, svc).toHaveLength(0);
      expect(await payerFor(payer, await servicePrincipalId({ issuer: c.issuer, service: svc })), svc).toBeNull();
    }

    // A second connect changes no binding. git-review then asks (the ask makes its principal) and the ask's own transaction binds it to the same record.
    await c.send(await c.sign({ act: "connect", cap: 1500, seq: 2 }));
    expect(await findServicePrincipal(sql as unknown as SqlTag, { issuer: c.issuer, service: "git-review" })).toBeNull();
    const bound = await sql.begin(async (tx) => {
      const userId = await ensureServicePrincipal(tx as unknown as SqlTag, { issuer: c.issuer, service: "git-review" });
      return createPostgresConnectionStore(tx as unknown as SqlTag).bindService({ issuer: c.issuer, subjectUserId: userId });
    });
    expect(bound).toBe(true);
    expect(await payerFor(payer, await servicePrincipalId({ issuer: c.issuer, service: "git-review" }))).toBe(account);
    expect(await sql`SELECT 1 FROM payer_bindings WHERE billing_account_id = ${account} AND revoked_at IS NULL`).toHaveLength(2);
  });

  it("a seq more than MAX_SEQ_STEP above the stored one is refused (nothing created on a first connect)", async () => {
    const c = await customer();
    expect(await c.send(await c.sign({ act: "connect", cap: 1, seq: MAX_SEQ_STEP + 1 }))).toMatchObject({ verified: true, outcome: { ok: false, code: "seq_jump" } });
    expect(await row(c.issuer)).toBeUndefined();
    await c.send(await c.sign({ act: "connect", cap: 1000, seq: 5 }));
    expect(await c.send(await c.sign({ act: "connect", cap: 1000, seq: 5 + MAX_SEQ_STEP + 1 }))).toMatchObject({ verified: true, outcome: { ok: false, code: "seq_jump", seq: 5 } });
    expect(await c.send(await c.sign({ act: "connect", cap: 1000, seq: 5 + MAX_SEQ_STEP }))).toMatchObject({ verified: true, outcome: { ok: true } });
  });

  it("a customer whose local seq is more than 1M above the provider's fails ONE click (seq_jump), aligns to the provider's seq and then connects", async () => {
    const c = await customer();
    const origin = `https://provider-${randomUUID()}.example.org`;
    const outbound = createPostgresOutboundConnectionStore(sql as unknown as SqlTag);
    // The provider side runs in-test: the real verifier, the durable replay store and the real connection store, answering as the route does.
    const provider = (async (_url: string, init: RequestInit) => {
      const token = String((init.headers as Record<string, string>).authorization).replace(/^Bearer /, "");
      const sent = await c.send(token);
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (!sent.verified) return reply(401, { error: "invalid_token" });
      if (sent.outcome.ok) return reply(200, { status: sent.outcome.record.status, cap: sent.outcome.record.cap, seq: sent.outcome.record.seq });
      return reply(409, { error: sent.outcome.code, seq: sent.outcome.seq });
    }) as unknown as typeof fetch;
    const sender = createConnectSender({
      targets: [{ alias: "prov", nodeId: NODE, origin }],
      signer: async () => c.signer,
      store: outbound,
      fetchImpl: provider,
    });

    // The provider holds this customer at seq 5; the customer's local table is far ahead (a long-lived node).
    await c.send(await c.sign({ act: "connect", cap: 1000, seq: 5 }));
    await sql`INSERT INTO outbound_connections (target_origin, status, cap, seq) VALUES (${origin}, 'disconnected', 0, ${2 * MAX_SEQ_STEP})`;

    // One click fails: 2,000,001 is more than 1,000,000 above 5. The answer carries the stored seq and the customer aligns to it.
    expect(await sender.act({ alias: "prov", act: "connect", cap: 700 })).toMatchObject({ ok: true, httpStatus: 409, status: null, error: "seq_jump", target: { status: "not_connected" } });
    expect((await outbound.states([origin])).get(origin)?.seq).toBe(5);
    // The next click lands (seq 6) and the provider's record carries the new cap.
    expect(await sender.act({ alias: "prov", act: "connect", cap: 700 })).toMatchObject({ ok: true, httpStatus: 200, status: "connected", target: { status: "connected", cap: 700 } });
    expect(await row(c.issuer)).toMatchObject({ seq: "6", cap: "700", status: "connected" });
  });

  it("this node's own outbound state: seq rises across instances, a stale-guarded accept does not overwrite a newer one, and a lift never lowers", async () => {
    const origin = `https://prov-${randomUUID()}.example.org`;
    const a = createPostgresOutboundConnectionStore(sql as unknown as SqlTag);
    const b = createPostgresOutboundConnectionStore(sql as unknown as SqlTag);
    expect(await a.reserveSeq(origin)).toEqual({ seq: 1, cap: 0 });
    expect(await b.reserveSeq(origin)).toEqual({ seq: 2, cap: 0 });
    await b.accept({ origin, status: "connected", cap: 900, reservedSeq: 2 });
    // The slower answer of seq 1 arrives last and must not overwrite.
    await a.accept({ origin, status: "connected", cap: 100, reservedSeq: 1 });
    expect((await a.states([origin])).get(origin)).toEqual({ status: "connected", cap: 900, seq: 2 });
    await a.liftSeq(origin, 40);
    await a.liftSeq(origin, 3);
    expect((await a.states([origin])).get(origin)?.seq).toBe(40);
    await a.alignSeq(origin, 6);
    expect((await a.states([origin])).get(origin)?.seq).toBe(6);
    expect((await a.states([`${origin}x`])).size).toBe(0);
  });

  it("the cap and a zero balance each refuse a run; a new connect replaces the cap and keeps the count; Disconnect refuses the next run", async () => {
    const c = await customer();
    await c.send(await c.sign({ act: "connect", cap: 1000, seq: 1 }));
    const account = (await row(c.issuer))?.billing_account_id as string;

    // No allowance yet: the balance is zero.
    expect(await gate(account)).toBe("connection_allowance_empty");
    await setBalance(account, 50_000);
    expect(await gate(account)).toBeNull();

    await charge(account, 999);
    expect(await gate(account)).toBeNull();
    await charge(account, 1);
    expect(await gate(account)).toBe("connection_cap_reached");

    // The allowance is still large, but the cap decides; a new connect raises it and the 1000 already spent still count.
    await c.send(await c.sign({ act: "connect", cap: 1500, seq: 2 }));
    expect(await gate(account)).toBeNull();
    await charge(account, 500);
    expect(await gate(account)).toBe("connection_cap_reached");

    // A zero balance refuses even far under the cap.
    await c.send(await c.sign({ act: "connect", cap: 10_000_000, seq: 3 }));
    expect(await gate(account)).toBeNull();
    await setBalance(account, 0);
    expect(await gate(account)).toBe("connection_allowance_empty");
    await setBalance(account, 10);

    // Disconnect stops billing on the very next run, and keeps the cap.
    await c.send(await c.sign({ act: "disconnect", cap: 0, seq: 4 }));
    expect(await gate(account)).toBe("connection_disconnected");
    expect(await row(c.issuer)).toMatchObject({ status: "disconnected", cap: "10000000" });
  });

  it("an account that is not a connection record is never refused by the gate", async () => {
    expect(await gate(randomUUID())).toBeNull();
  });

  it("an allowance is ONE ledger row through the real accounts adapter: idempotent by key, race-safe, and 404-shaped for an unknown org", async () => {
    const c = await customer();
    await c.send(await c.sign({ act: "connect", cap: 1000, seq: 1 }));
    const record = await row(c.issuer);
    const orgUserId = record?.org_user_id as string;
    const account = record?.billing_account_id as string;
    const connections = createConnections({
      sql,
      trustedHomes: [c.home],
      accounts: new ServiceDrizzleAccountService(getSeedDb()),
      log: logger(),
    });

    const key = randomUUID();
    expect(await connections.grantAllowance({ orgUserId, credits: 500, key })).toEqual({ allowance: 500, applied: true });
    expect(await connections.grantAllowance({ orgUserId, credits: 500, key })).toEqual({ allowance: 500, applied: false });
    expect(await connections.grantAllowance({ orgUserId, credits: 250, key: randomUUID() })).toEqual({ allowance: 750, applied: true });

    // Two requests with one new key at once: exactly one ledger row, and both answer.
    const race = randomUUID();
    const both = await Promise.all([connections.grantAllowance({ orgUserId, credits: 100, key: race }), connections.grantAllowance({ orgUserId, credits: 100, key: race })]);
    expect(both.filter((r) => r?.applied).length).toBe(1);
    const ledger = await sql`SELECT amount::text AS amount, reason FROM credit_ledger WHERE billing_account_id = ${account} ORDER BY created_at`;
    expect(ledger.every((r) => r.reason === "connection_allowance")).toBe(true);
    expect(ledger.map((r) => r.amount).sort()).toEqual(["100", "250", "500"]);
    expect((await sql`SELECT balance_credits::text AS b FROM billing_accounts WHERE id = ${account}`)[0]?.b).toBe("850");

    expect(await connections.grantAllowance({ orgUserId: randomUUID(), credits: 5, key: randomUUID() })).toBeNull();
  });

  it("the provider's list shows status, allowance, debits, cap and last call, pages by issuer, and Suspended wins the display status", async () => {
    const c = await customer();
    await c.send(await c.sign({ act: "connect", cap: 700, seq: 1 }));
    const record = await row(c.issuer);
    const account = record?.billing_account_id as string;
    await setBalance(account, 40);
    await charge(account, 15);
    const store = createPostgresConnectionStore(sql as unknown as SqlTag);
    await store.setSuspended(record?.org_user_id as string, true);

    const rows = await store.list({ limit: 100, after: null });
    const mine = rows.find((r) => r.issuer === c.issuer);
    expect(mine).toMatchObject({ status: "connected", suspended: true, cap: 700, balance: 40, debits: 15 });
    expect(mine?.lastCallAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Bounded: at most limit + 1 rows come back whatever the table holds.
    expect((await store.list({ limit: 1, after: null })).length).toBeLessThanOrEqual(2);
  });
});
