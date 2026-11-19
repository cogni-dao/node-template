// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/service-connections`
 * Purpose: The CUSTOMER side of connect from home (story.0038): this node signs ONE assertion as service `node-connect` with `act`, `cap` and a rising `seq`, posts it to a configured provider,
 *   and shows the provider's answer. The assertion is checked by the REAL verifier, so the claims on the wire are exactly what the provider reads.
 * Scope: A fake `outbound_connections` table behind the SQL tag, a fake provider behind `fetch`. No database, no network.
 * Invariants: SEQ_RISES_ACROSS_RESTARTS (a second instance over the same table signs a higher seq; a failed send never reuses one; a provider's stale answer lifts the seq above its stored one),
 *   ALIAS_FROM_SERVER_CONFIG, NO_SIGNER_NO_CALL, STATE_IS_MY_OWN_ACT (only a provider 200 moves status and cap), FIXED_POST, NO_TOKEN_IN_LOGS.
 * Side-effects: none
 */

import { CONNECT_SCOPE } from "@cogni/agent-grants";
import {
  createMemoryReplayStore,
  createServiceAssertionSignerFromSeed,
  createServiceAssertionVerifier,
  type LinkTarget,
  type ServiceAssertionSigner,
} from "@cogni/agent-grants/service-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAuthoritySql } from "@/bootstrap/agent-authority";
import { createServiceConnections } from "@/bootstrap/service-connections";

const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const HOME = "https://home.example.org";
const TARGET: LinkTarget = { alias: "prov", nodeId: "prov-node", origin: "https://prov.example.org", offer: "Shared AI, paid from your cap." };

interface Row {
  status: "connected" | "disconnected";
  cap: number;
  seq: number;
}

/** The `outbound_connections` table as the SQL tag sees it: the same atomic seq take, status/cap write and GREATEST lift the real statements make. */
function table() {
  const rows = new Map<string, Row>();
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    if (text.includes("INSERT INTO outbound_connections")) {
      const origin = values[0] as string;
      const row = rows.get(origin);
      if (row) row.seq += 1;
      else rows.set(origin, { status: "disconnected", cap: 0, seq: 1 });
      const now = rows.get(origin) as Row;
      return Promise.resolve([{ seq: String(now.seq), cap: String(now.cap) }]);
    }
    if (text.includes("UPDATE outbound_connections SET status")) {
      const [status, cap, origin] = values as [Row["status"], number, string];
      const row = rows.get(origin);
      if (row) Object.assign(row, { status, cap });
      return Promise.resolve([]);
    }
    if (text.includes("SET seq = GREATEST")) {
      const [seq, origin] = values as [number, string];
      const row = rows.get(origin);
      if (row) row.seq = Math.max(row.seq, seq);
      return Promise.resolve([]);
    }
    if (text.includes("WHERE target_origin = ANY")) {
      const origins = values[0] as string[];
      return Promise.resolve(origins.flatMap((o) => (rows.has(o) ? [{ target_origin: o, status: rows.get(o)?.status, cap: String(rows.get(o)?.cap) }] : [])));
    }
    if (text.includes("FROM outbound_connections WHERE target_origin")) {
      const row = rows.get(values[0] as string);
      return Promise.resolve(row ? [{ status: row.status, cap: String(row.cap) }] : []);
    }
    throw new Error(`unexpected statement: ${text}`);
  }) as unknown as AgentAuthoritySql;
  return { rows, tag };
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("service connections (this node as a customer)", () => {
  let signer: ServiceAssertionSigner;
  let tbl: ReturnType<typeof table>;
  let provider: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof log>;

  const build = (over: { signer?: ServiceAssertionSigner | null; targets?: LinkTarget[]; sql?: AgentAuthoritySql } = {}) =>
    createServiceConnections({
      targets: over.targets ?? [TARGET],
      signer: async () => (over.signer === undefined ? signer : over.signer),
      sql: over.sql ?? tbl.tag,
      log: logger as never,
      fetchImpl: provider as unknown as typeof fetch,
    });

  /** The provider's verifier: trusts this node's home and the node-connect service, so the claims it reads are the ones that were signed. */
  const providerVerify = (authorization: string) =>
    createServiceAssertionVerifier({
      selfNodeId: TARGET.nodeId,
      trustedHomes: [{ issuer: HOME, jwksUri: `${HOME}/.well-known/jwks.json`, services: ["node-connect"] }],
      fetchJwks: async () => signer.jwks(),
      replay: createMemoryReplayStore(),
    }).verify(authorization.replace(/^Bearer /, ""));

  beforeEach(async () => {
    signer = await createServiceAssertionSignerFromSeed({ issuer: HOME, seedHex: SEED });
    tbl = table();
    logger = log();
    provider = vi.fn(async () => json(200, { status: "connected", cap: 1000, seq: 1 }));
  });

  it("an alias that is not a configured target is refused before any signing, network or write", async () => {
    expect(await build().act({ alias: "elsewhere", act: "disconnect" })).toEqual({ ok: false, reason: "unknown_alias" });
    expect(provider).not.toHaveBeenCalled();
    expect(tbl.rows.size).toBe(0);
  });

  it("with no signing key nothing is sent and no seq is taken, and the list says so", async () => {
    const c = build({ signer: null });
    expect(await c.act({ alias: "prov", act: "connect", cap: 5 })).toEqual({ ok: false, reason: "no_signer" });
    expect(provider).not.toHaveBeenCalled();
    expect(tbl.rows.size).toBe(0);
    expect((await c.list()).signer).toBe(false);
  });

  it("a connect signs act, cap and seq as node-connect for the target's audience, posts once to the fixed path, and records only the provider's acceptance", async () => {
    const result = await build().act({ alias: "prov", act: "connect", cap: 1000 });
    expect(result).toMatchObject({ ok: true, alias: "prov", act: "connect", httpStatus: 200, status: "connected", error: null, target: { alias: "prov", status: "connected", cap: 1000 } });

    expect(provider).toHaveBeenCalledTimes(1);
    const [url, init] = provider.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://prov.example.org/api/v1/public/agent/service-connections");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", body: "{}" });
    const authorization = (init.headers as Record<string, string>).authorization as string;
    expect(await providerVerify(authorization)).toMatchObject({
      ok: true,
      issuer: HOME,
      service: "node-connect",
      scope: CONNECT_SCOPE,
      claims: { act: "connect", cap: 1000, seq: 1 },
    });
    expect(tbl.rows.get(TARGET.origin)).toEqual({ status: "connected", cap: 1000, seq: 1 });
    // The log names the alias, the act and the answer, never the assertion.
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(authorization.slice(7, 40));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "connection.sent", alias: "prov", act: "connect", httpStatus: 200, status: "connected" }), "connection.sent");
  });

  it("seq rises across a restart: a new instance over the same table signs the next seq, and a disconnect signs the cap the provider last accepted", async () => {
    await build().act({ alias: "prov", act: "connect", cap: 1000 });
    provider.mockResolvedValue(json(200, { status: "disconnected", cap: 1000, seq: 2 }));
    const restarted = build();
    const result = await restarted.act({ alias: "prov", act: "disconnect" });
    expect(result).toMatchObject({ ok: true, status: "disconnected", target: { status: "not_connected", cap: null } });
    const authorization = ((provider.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>).authorization as string;
    expect(await providerVerify(authorization)).toMatchObject({ ok: true, claims: { act: "disconnect", cap: 1000, seq: 2 } });
    expect(tbl.rows.get(TARGET.origin)?.seq).toBe(2);
  });

  it("a failed send never reuses a seq, and an unreachable provider is reported without changing state", async () => {
    provider.mockRejectedValueOnce(new Error("network down"));
    expect(await build().act({ alias: "prov", act: "connect", cap: 5 })).toEqual({ ok: false, reason: "unreachable" });
    expect(tbl.rows.get(TARGET.origin)).toEqual({ status: "disconnected", cap: 0, seq: 1 });
    await build().act({ alias: "prov", act: "connect", cap: 5 });
    const authorization = ((provider.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>).authorization as string;
    expect(await providerVerify(authorization)).toMatchObject({ claims: { seq: 2 } });
  });

  it("a provider refusal is shown as its plain code and changes neither status nor cap; a hostile error text is dropped", async () => {
    await build().act({ alias: "prov", act: "connect", cap: 1000 });
    provider.mockResolvedValue(json(401, { error: "invalid_token" }));
    const refused = await build().act({ alias: "prov", act: "connect", cap: 9999 });
    expect(refused).toMatchObject({ ok: true, httpStatus: 401, status: null, error: "invalid_token", target: { status: "connected", cap: 1000 } });
    provider.mockResolvedValue(json(400, { error: "Bad <script>alert(1)</script>" }));
    expect(await build().act({ alias: "prov", act: "connect", cap: 5 })).toMatchObject({ httpStatus: 400, error: null });
    provider.mockResolvedValue(new Response("not json", { status: 502 }));
    expect(await build().act({ alias: "prov", act: "connect", cap: 5 })).toMatchObject({ httpStatus: 502, status: null, error: null });
  });

  it("a stale_seq answer carries the provider's stored seq and this node rises above it, so the next click lands", async () => {
    provider.mockResolvedValue(json(409, { error: "stale_seq", seq: 7 }));
    const stale = await build().act({ alias: "prov", act: "connect", cap: 5 });
    expect(stale).toMatchObject({ httpStatus: 409, status: null, error: "stale_seq" });
    expect(tbl.rows.get(TARGET.origin)?.seq).toBe(7);
    provider.mockResolvedValue(json(200, { status: "connected", cap: 5, seq: 8 }));
    await build().act({ alias: "prov", act: "connect", cap: 5 });
    const authorization = ((provider.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>).authorization as string;
    expect(await providerVerify(authorization)).toMatchObject({ claims: { act: "connect", cap: 5, seq: 8 } });
  });

  it("the list shows each configured target with its offer from config, and this node's own status and cap", async () => {
    const c = build({ targets: [TARGET, { alias: "other", nodeId: "o", origin: "https://other.example.org" }] });
    expect(await c.list()).toEqual({
      signer: true,
      targets: [
        { alias: "prov", origin: TARGET.origin, offer: TARGET.offer, status: "not_connected", cap: null },
        { alias: "other", origin: "https://other.example.org", status: "not_connected", cap: null },
      ],
    });
    await c.act({ alias: "prov", act: "connect", cap: 1000 });
    expect((await c.list()).targets[0]).toMatchObject({ status: "connected", cap: 1000 });
  });
});
