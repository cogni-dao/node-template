// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_SCOPE, createConnectSender, type OutboundConnectionStore, type OutboundState } from "../src";
import {
  createMemoryReplayStore,
  createServiceAssertionSignerFromSeed,
  createServiceAssertionVerifier,
  type LinkTarget,
  type ServiceAssertionSigner,
} from "../src/service-auth";

const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const HOME = "https://home.example.org";
const TARGET: LinkTarget = { alias: "prov", nodeId: "prov-node", origin: "https://prov.example.org", offer: "Shared AI, paid from your cap." };

/** The same atomic seq take, guarded accept and GREATEST lift the Postgres statements make. */
function memoryOutbound(): OutboundConnectionStore & { rows: Map<string, OutboundState> } {
  const rows = new Map<string, OutboundState>();
  return {
    rows,
    async reserveSeq(origin) {
      const row = rows.get(origin);
      if (row) rows.set(origin, { ...row, seq: row.seq + 1 });
      else rows.set(origin, { status: "disconnected", cap: 0, seq: 1 });
      const now = rows.get(origin) as OutboundState;
      return { seq: now.seq, cap: now.cap };
    },
    async states(origins) {
      return new Map(origins.flatMap((o) => (rows.has(o) ? [[o, rows.get(o) as OutboundState] as const] : [])));
    },
    async accept({ origin, status, cap, reservedSeq }) {
      const row = rows.get(origin);
      if (row && row.seq <= reservedSeq) rows.set(origin, { ...row, status, cap });
    },
    async liftSeq(origin, seq) {
      const row = rows.get(origin);
      if (row) rows.set(origin, { ...row, seq: Math.max(row.seq, seq) });
    },
    async alignSeq(origin, seq) {
      const row = rows.get(origin);
      if (row) rows.set(origin, { ...row, seq });
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("connect sender (this node as a customer)", () => {
  let signer: ServiceAssertionSigner;
  let store: ReturnType<typeof memoryOutbound>;
  let provider: ReturnType<typeof vi.fn>;
  let sent: ReturnType<typeof vi.fn>;

  const build = (over: { signer?: ServiceAssertionSigner | null; targets?: LinkTarget[]; store?: OutboundConnectionStore } = {}) =>
    createConnectSender({
      targets: over.targets ?? [TARGET],
      signer: async () => (over.signer === undefined ? signer : over.signer),
      store: over.store ?? store,
      fetchImpl: provider as unknown as typeof fetch,
      onSent: sent as never,
    });
  const authorizationOf = (call: number) => ((provider.mock.calls[call] as [string, RequestInit])[1].headers as Record<string, string>).authorization as string;

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
    store = memoryOutbound();
    sent = vi.fn();
    provider = vi.fn(async () => json(200, { status: "connected", cap: 1000, seq: 1 }));
  });

  it("an alias that is not a configured target is refused before any signing, network or write", async () => {
    expect(await build().act({ alias: "elsewhere", act: "disconnect" })).toEqual({ ok: false, reason: "unknown_alias" });
    expect(provider).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it("with no signing key nothing is sent and no seq is taken, and the list says so", async () => {
    const c = build({ signer: null });
    expect(await c.act({ alias: "prov", act: "connect", cap: 5 })).toEqual({ ok: false, reason: "no_signer" });
    expect(provider).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
    expect((await c.list()).signer).toBe(false);
  });

  it("a connect signs act, cap and seq as node-connect for the target's audience, posts once to the fixed path, and records only the provider's acceptance", async () => {
    const result = await build().act({ alias: "prov", act: "connect", cap: 1000 });
    expect(result).toMatchObject({ ok: true, alias: "prov", act: "connect", httpStatus: 200, status: "connected", error: null, target: { alias: "prov", status: "connected", cap: 1000 } });
    expect(provider).toHaveBeenCalledTimes(1);
    const [url, init] = provider.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://prov.example.org/api/v1/public/agent/service-connections");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", body: "{}" });
    expect(await providerVerify(authorizationOf(0))).toMatchObject({ ok: true, issuer: HOME, service: "node-connect", scope: CONNECT_SCOPE, claims: { act: "connect", cap: 1000, seq: 1 } });
    expect(store.rows.get(TARGET.origin)).toEqual({ status: "connected", cap: 1000, seq: 1 });
    expect(sent).toHaveBeenCalledWith({ alias: "prov", act: "connect", outcome: "answered", httpStatus: 200, status: "connected" });
    expect(JSON.stringify(sent.mock.calls)).not.toContain(authorizationOf(0).slice(7, 40));
  });

  it("seq rises across a restart, and a disconnect signs the cap the provider last accepted", async () => {
    await build().act({ alias: "prov", act: "connect", cap: 1000 });
    provider.mockResolvedValue(json(200, { status: "disconnected", cap: 1000, seq: 2 }));
    const result = await build().act({ alias: "prov", act: "disconnect" });
    expect(result).toMatchObject({ ok: true, status: "disconnected", target: { status: "not_connected", cap: null } });
    expect(await providerVerify(authorizationOf(1))).toMatchObject({ ok: true, claims: { act: "disconnect", cap: 1000, seq: 2 } });
  });

  it("a failed send never reuses a seq, and an unreachable provider is reported without changing state", async () => {
    provider.mockRejectedValueOnce(new Error("network down"));
    expect(await build().act({ alias: "prov", act: "connect", cap: 5 })).toEqual({ ok: false, reason: "unreachable" });
    expect(store.rows.get(TARGET.origin)).toEqual({ status: "disconnected", cap: 0, seq: 1 });
    expect(sent).toHaveBeenCalledWith({ alias: "prov", act: "connect", outcome: "unreachable" });
    await build().act({ alias: "prov", act: "connect", cap: 5 });
    expect(await providerVerify(authorizationOf(1))).toMatchObject({ claims: { seq: 2 } });
  });

  it("a slow answer never overwrites a newer send: accept is guarded by the reserved seq", async () => {
    let release: (r: Response) => void = () => undefined;
    provider.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
    const slow = build().act({ alias: "prov", act: "connect", cap: 100 });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    // A newer send reserves seq 2 and is accepted first.
    provider.mockResolvedValueOnce(json(200, { status: "connected", cap: 900, seq: 2 }));
    await build().act({ alias: "prov", act: "connect", cap: 900 });
    release(json(200, { status: "connected", cap: 100, seq: 1 }));
    await slow;
    expect(store.rows.get(TARGET.origin)).toEqual({ status: "connected", cap: 900, seq: 2 });
  });

  it("a provider refusal is shown as its plain code and changes neither status nor cap; a hostile error text is dropped", async () => {
    await build().act({ alias: "prov", act: "connect", cap: 1000 });
    provider.mockResolvedValue(json(401, { error: "invalid_token" }));
    expect(await build().act({ alias: "prov", act: "connect", cap: 9999 })).toMatchObject({ ok: true, httpStatus: 401, status: null, error: "invalid_token", target: { status: "connected", cap: 1000 } });
    provider.mockResolvedValue(json(400, { error: "Bad <script>alert(1)</script>" }));
    expect(await build().act({ alias: "prov", act: "connect", cap: 5 })).toMatchObject({ httpStatus: 400, error: null });
    provider.mockResolvedValue(new Response("not json", { status: 502 }));
    expect(await build().act({ alias: "prov", act: "connect", cap: 5 })).toMatchObject({ httpStatus: 502, status: null, error: null });
  });

  it("a stale_seq answer carries the provider's stored seq and this node rises above it; a seq_jump answer (the provider's admin reset it) aligns this node to it exactly, so the next click lands", async () => {
    provider.mockResolvedValue(json(409, { error: "stale_seq", seq: 7 }));
    expect(await build().act({ alias: "prov", act: "connect", cap: 5 })).toMatchObject({ httpStatus: 409, status: null, error: "stale_seq" });
    expect(store.rows.get(TARGET.origin)?.seq).toBe(7);
    provider.mockResolvedValue(json(200, { status: "connected", cap: 5, seq: 8 }));
    await build().act({ alias: "prov", act: "connect", cap: 5 });
    expect(await providerVerify(authorizationOf(1))).toMatchObject({ claims: { act: "connect", cap: 5, seq: 8 } });
    // The provider's admin reset the record to 1 while this node's local seq is 9: a jump. Align to 3 (what it says), never stay above it.
    provider.mockResolvedValue(json(409, { error: "seq_jump", seq: 3 }));
    await build().act({ alias: "prov", act: "connect", cap: 5 });
    expect(store.rows.get(TARGET.origin)?.seq).toBe(3);
    provider.mockResolvedValue(json(200, { status: "connected", cap: 5, seq: 4 }));
    await build().act({ alias: "prov", act: "connect", cap: 5 });
    expect(await providerVerify(authorizationOf(3))).toMatchObject({ claims: { act: "connect", cap: 5, seq: 4 } });
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
