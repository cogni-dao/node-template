// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Behavioral crash/concurrency fixtures; SQL lock/FK proof runs separately in component CI. */
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { credentialHttp, credentialDenialHttp } from "../src/credentials/http";
import { mintKey } from "../src/credentials/service";
import {
  type ConnectionKey,
  createEnrollmentTokenVerifier,
  durableEnrollmentHttp,
  ENROLLMENT_PROTOCOL,
  type EnrollmentProof,
  sealToJwk,
} from "../src/enrollment";
import { EnrollmentClientError } from "../src/enrollment/client/transport";
import {
  createCustodyCipher,
  createEnrollmentProofSigner,
  createEnrollmentRequester,
  createEnrollmentTransport,
  createServiceLinkHandlers,
} from "../src/enrollment/requester";
import type {
  LeaseGuard,
  LinkRow,
  RequesterStore,
  RequesterVault,
} from "../src/enrollment/requester/types";

const key: ConnectionKey = {
  home: {
    nodeId: "11111111-1111-4111-8111-111111111111",
    environment: "candidate-a",
    origin: "https://home.example",
  },
  target: {
    nodeId: "22222222-2222-4222-8222-222222222222",
    environment: "candidate-a",
    origin: "https://target.example",
  },
  service: "node-ai",
  billingAccountId: "system",
};
const clone = <T>(v: T): T => structuredClone(v);
async function fixture(discovery?: unknown) {
  let time = Date.parse("2026-11-12T01:00:00Z"),
    row: LinkRow | null = null,
    accepted: EnrollmentProof | null = null,
    receipt = "",
    sealedKey = "";
  let bearer = "",
    credentialId = "",
    connected = false,
    starts = 0,
    confirms = 0,
    reserves = 0,
    polls = 0;
  let dropStart = false,
    dropConfirm = false,
    dropPublish = false,
    rejectStage = false,
    failReserve = false,
    throttleConfirm = false,
    terminalRemote = false,
    ambiguousRemote = false;
  let missingAt: string | null = null, receiverSkew = 0, activatedAt: number | null = null;
  let confirmRefusal: "permission_off" | "expired" | "revoked" | null = null;
  let confirmAuthFailure = false, untypedTerminal = false, unknownConfirm = false, oversizedConfirm = false;
  const signerKey = await generateKeyPair("EdDSA");
  const signer = createEnrollmentProofSigner({
    kid: "k1",
    key: signerKey.privateKey,
  });
  const verifier = createEnrollmentTokenVerifier({
    nodeId: key.target.nodeId,
    receiver: key.target,
    homes: [
      {
        ...key.home,
        kids: ["k1"],
        services: { "node-ai": ["knowledge:read"] },
      },
    ],
    keysFor: () =>
      createLocalJWKSet({
        keys: [{ ...awaitedPublic, kid: "k1", alg: "EdDSA" }],
      }),
    now: () => new Date(time + receiverSkew),
  });
  const awaitedPublic = await exportJWK(signerKey.publicKey);
  const cipher = createCustodyCipher(new Uint8Array(32).fill(7), "test");
  const matches = (g: LeaseGuard) =>
    row &&
    row.operationId === g.operationId &&
    JSON.stringify(row.state.key) === JSON.stringify(g.key) &&
    row.revision === g.revision &&
    row.fence === g.fence &&
    row.leaseOwner === g.leaseOwner &&
    Date.parse(row.leaseUntil ?? "") > time;
  const store: RequesterStore = {
    durable: true,
    async reserve(r) {
      reserves++;
      if (failReserve) throw new Error("disk unavailable");
      row ??= clone(r);
      return clone(row);
    },
    async replace(h, revision, draft) {
      if (!row || row.operationId !== h.operationId || row.revision !== revision ||
          JSON.stringify(row.state.key) !== JSON.stringify(h.key)) return null;
      row = clone(draft);
      return clone(row);
    },
    async read(h) {
      return row &&
        row.operationId === h.operationId &&
        JSON.stringify(row.state.key) === JSON.stringify(h.key)
        ? clone(row)
        : null;
    },
    async acquire(h, owner) {
      if (
        !row ||
        row.operationId !== h.operationId ||
        JSON.stringify(row.state.key) !== JSON.stringify(h.key) ||
        ["disconnected", "denied", "expired", "expired_unknown", "needs_reenroll"].includes(row.state.phase) ||
        Date.parse(row.nextAttemptAt) > time ||
        Date.parse(row.leaseUntil ?? "") > time
      )
        return null;
      if (Date.parse(row.secretDeadline) <= time && !row.state.connectionId) {
        row.state.phase = "expired_unknown";
        row.state.nextAction = "none";
        row.encryptedSecrets = null;
        return null;
      }
      row = {
        ...row,
        revision: row.revision + 1,
        fence: row.fence + 1,
        leaseOwner: owner,
        leaseUntil: new Date(time + 30000).toISOString(),
      };
      return clone(row);
    },
    async update(g, change) {
      if (!matches(g) || !row) return null;
      row = {
        ...row,
        state: clone(change.state),
        fence: row.fence + ((change.state.nonacceptanceObservedAt && !row.state.nonacceptanceObservedAt) || (change.state.terminalObservedAt && !row.state.terminalObservedAt) ? 1 : 0),
        revision: row.revision + 1,
        encryptedSecrets:
          change.encryptedSecrets === undefined
            ? row.encryptedSecrets
            : change.encryptedSecrets,
        nextAttemptAt: new Date(
          time + (change.delaySec ?? 0) * 1000
        ).toISOString(),
        leaseOwner: change.release ? null : row.leaseOwner,
        leaseUntil: change.release ? null : row.leaseUntil,
      };
      return clone(row);
    },
    async stage(g, e) {
      if (rejectStage) throw new Error("commit failed");
      if (!matches(g) || !row) return null;
      bearer = e.token;
      credentialId = e.credentialId;
      row = {
        ...row,
        revision: row.revision + 1,
        state: {
          ...row.state,
          connectionId: "stage",
          credentialId,
          phase: "key_staged",
          nextAction: "confirm",
        },
        leaseOwner: null,
        leaseUntil: null,
        secretDeadline: new Date(time + receiverSkew + 44 * 86400000).toISOString(),
      };
      return clone(row);
    },
    async publish(g, deadlines) {
      if (!matches(g) || !row) return null;
      row = {
        ...row,
        revision: row.revision + 1,
        state: {
          ...row.state,
          ...deadlines,
          phase: "connected",
          nextAction: "none",
        },
        leaseOwner: null,
        leaseUntil: null,
      };
      if (dropPublish) {
        dropPublish = false;
        throw new Error("publication response lost");
      }
      return clone(row);
    },
    async disconnect(h, revision) {
      if (
        !row ||
        row.operationId !== h.operationId ||
        row.revision !== revision
      )
        return null;
      row = {
        ...row,
        revision: row.revision + 1,
        fence: row.fence + 1,
        leaseOwner: null,
        leaseUntil: null,
        state: { ...row.state, phase: "disconnected", nextAction: "none" },
      };
      return clone(row);
    },
    async keyRejected() {
      return false;
    },
  };
  const vault: RequesterVault = {
    async readStaged(g, id, cid) {
      return matches(g) && id === "stage" && cid === credentialId
        ? bearer
        : null;
    },
    async resolveServiceConnection() {
      return connected ? bearer : null;
    },
  };
  const refuseProof = (token: string, reason: "unknown_operation" | "terminal_operation", observedAt: string, typed = true) => {
    const http = durableEnrollmentHttp({ok:false,reason,observedAt});
    const wire = createEnrollmentTransport({fetch:async () => Response.json(typed ? http.body : {observedAt}, {status:http.status,headers:http.headers})});
    return wire.postProof(key.target.origin,token);
  };
  const transport = {
    async postProof(tokenOrigin: string, token: string) {
      expect(tokenOrigin).toBe(key.target.origin);
      if (!row?.state.nextAction || row.state.nextAction !== "none") expect(row?.encryptedSecrets).toBeTruthy(); // Intent committed before the effect; terminal reconciliation needs no erased private key.
      const checked = await verifier(token);
      if (!checked.ok) throw new Error("bad proof");
      const p = checked.claims;
      if (missingAt) return refuseProof(token,"unknown_operation",missingAt);
      if (ambiguousRemote) throw new EnrollmentClientError("origin_unreachable");
      if (accepted && terminalRemote) {
        if (p.op === "continue") return refuseProof(token,"terminal_operation",new Date(time+receiverSkew).toISOString(),!untypedTerminal);
        expect(p.expectedOperationId).toBe(accepted.operationId);
        expect(p.expectedGeneration).toBe(accepted.generation);
        accepted = null;
        terminalRemote = false;
      }
      if (!accepted) {
        if (p.op !== "start")
          return refuseProof(token,"unknown_operation",new Date(time+receiverSkew).toISOString());
        if (!p.expectedOperationId) expect(p.expectedGeneration).toBe(0);
        starts++;
        accepted = p;
        const at = new Date(time + receiverSkew).toISOString();
        receipt = await sealToJwk(
          JSON.stringify({
            protocol: ENROLLMENT_PROTOCOL,
            operationId: p.operationId,
            generation: p.generation,
            intentDigest: p.intentDigest,
            home: p.home,
            target: p.target,
            service: p.service,
            scope: p.scopes[0],
            enrollmentId: "33333333-3333-4333-8333-333333333333",
            principalUserId: "target-agent",
            deviceCode: "a".repeat(43),
            acceptedAt: at,
            recoveryExpiresAt: new Date(time + receiverSkew + 86400000).toISOString(),
            interval: 5,
          }),
          p.cnf.jwk
        );
      } else expect(p.operationId).toBe(accepted.operationId);
      if (dropStart) {
        dropStart = false;
        throw new EnrollmentClientError("origin_unreachable");
      }
      return {
        operationId: p.operationId,
        generation: p.generation,
        status: connected ? ("confirmed" as const) : ("open" as const),
        sealedAcceptance: connected ? null : receipt,
        credentialId: credentialId || null,
        credentialState: connected
          ? ("active" as const)
          : credentialId
            ? ("pending" as const)
            : null,
        observedAt: new Date(time).toISOString(),
      };
    },
    async pollToken() {
      polls++;
      if (!accepted) throw new Error("start missing");
      if (!sealedKey) {
        const minted = await mintKey();
        credentialId = crypto.randomUUID();
        bearer = minted.token;
        sealedKey = await sealToJwk(
          JSON.stringify({
            protocol: ENROLLMENT_PROTOCOL,
            operationId: accepted.operationId,
            generation: accepted.generation,
            intentDigest: accepted.intentDigest,
            home: accepted.home,
            target: accepted.target,
            service: accepted.service,
            scope: accepted.scopes[0],
            enrollmentId: "33333333-3333-4333-8333-333333333333",
            principalUserId: "target-agent",
            credentialId,
            token: bearer,
            pendingExpiresAt: new Date(time + receiverSkew + 900000).toISOString(),
            expiresAt: new Date(time + receiverSkew + 30 * 86400000).toISOString(),
            renewUntil: new Date(time + receiverSkew + 44 * 86400000).toISOString(),
          }),
          accepted.cnf.jwk
        );
      }
      return {
        kind: "issued" as const,
        sealedKey,
        credentialId,
        pendingExpiresAt: new Date(time + receiverSkew + 900000).toISOString(),
      };
    },
    async confirmStaged(origin: string, token: string) {
      expect(origin).toBe(key.target.origin);
      confirms++;
      expect(row?.state.phase).toBe("confirm_unknown");
      expect(row?.state.connectionId).toBe("stage");
      expect(token).toBe(bearer);
      if (throttleConfirm) return { status: 429 };
      const wire = createEnrollmentTransport({ fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${bearer}`);
        if (unknownConfirm) return Response.json({}, {status:409});
        const replay = connected;
        if (!confirmRefusal && !confirmAuthFailure) {
          connected = true;
          activatedAt ??= time + receiverSkew;
          if (dropConfirm) { dropConfirm = false; throw new TypeError("confirmation reply lost"); }
        }
        const http = confirmAuthFailure ? credentialDenialHttp("invalid") : credentialHttp({ op: "confirm", credentialId,
          result: confirmRefusal ? {ok:false,reason:confirmRefusal} : {
            ok:true,status:replay ? "already_active" : "confirmed", userId:"target-agent",
            observedAt:new Date(time+receiverSkew).toISOString(),
            expiresAt:new Date((activatedAt ?? time) + (oversizedConfirm?31:30)*86400000).toISOString(),
            renewUntil:new Date((activatedAt ?? time) + (oversizedConfirm?45:44)*86400000).toISOString(),
          },
        });
        return Response.json(http.body,{status:http.status,headers:http.headers});
      } });
      return wire.confirmStaged(origin,token);
    },
  };
  const create = () =>
    createEnrollmentRequester({
      signer,
      transport,
      fetch: async () => Response.json(discovery ?? {
        nodeId: key.target.nodeId,
        serviceEnrollment: { protocol: ENROLLMENT_PROTOCOL, receiver: key.target, credentialCeilings: { ttlSec: 2592000, renewWindowSec: 1209600, pendingSec: 900 } },
      }),
      cipher,
      store,
      vault,
      now: () => new Date(time),
    });
  const step = async (requester: ReturnType<typeof create>) => {
    time += 61000;
    const r = row;
    if (!r) throw new Error("missing intent");
    return requester.advance({ operationId: r.operationId, key: r.state.key });
  };
  return {
    create,
    store,
    cipher,
    vault,
    get bearer() { return bearer; },
    terminalRemote: () => { terminalRemote = true; },
    ambiguousRemote: () => { ambiguousRemote = true; },
    missingAt: (at: string) => { missingAt = at; },
    skewTarget: (ms: number) => { receiverSkew = ms; },
    refuseConfirm: (reason: typeof confirmRefusal) => { confirmRefusal = reason; },
    rejectConfirmAuth: (on: boolean) => { confirmAuthFailure = on; },
    untypedTerminal: () => { untypedTerminal = true; },
    unknownConfirm: () => { unknownConfirm = true; },
    oversizedConfirm: () => { oversizedConfirm = true; },
    throttle: (on: boolean) => { throttleConfirm = on; },
    step,
    key,
    get row() {
      return clone(row);
    },
    get starts() {
      return starts;
    },
    get confirms() {
      return confirms;
    },
    get polls() {
      return polls;
    },
    get reserves() {
      return reserves;
    },
    shift: (ms: number) => {
      time += ms;
    },
    dropStart: () => {
      dropStart = true;
    },
    dropConfirm: () => {
      dropConfirm = true;
    },
    dropPublish: () => {
      dropPublish = true;
    },
    rejectStage: () => {
      rejectStage = true;
    },
    failReserve: () => {
      failReserve = true;
    },
  };
}

describe("durable enrollment requester", () => {
  it("sends no enrollment effect before successful encrypted reservation", async () => {
    const f = await fixture();
    f.failReserve();
    await expect(f.create().ensure(key)).rejects.toThrow("disk unavailable");
    expect(f.starts).toBe(0);
  });
  it("ensure refuses an oversized credential policy before reserving or starting", async () => {
    const f = await fixture({ nodeId: key.target.nodeId, serviceEnrollment: {
      protocol: ENROLLMENT_PROTOCOL, receiver: key.target, credentialCeilings: { ttlSec: 2592001, renewWindowSec: 1209600, pendingSec: 900 },
    } });
    await expect(f.create().ensure(key)).rejects.toThrow("unsupported_credential_policy");
    expect(f.row).toBeNull();
    expect(f.starts).toBe(0);
  });
  it("ensure refuses another environment at the configured origin before reserving", async () => {
    const f = await fixture({ nodeId: key.target.nodeId, serviceEnrollment: {
      protocol: ENROLLMENT_PROTOCOL, receiver: { ...key.target, environment: "production" }, credentialCeilings: { ttlSec: 2592000, renewWindowSec: 1209600, pendingSec: 900 },
    } });
    await expect(f.create().ensure(key)).rejects.toThrow("target_identity_mismatch");
    expect(f.row).toBeNull();
  });
  it("concurrent ensure reserves one exact token and operation", async () => {
    const f = await fixture();
    const r = f.create();
    const [a, b] = await Promise.all([r.ensure(key), r.ensure(key)]);
    expect(a.linkId).toBe(b.linkId);
    expect(f.row?.encryptedSecrets).not.toContain("privateJwk");
    expect(f.starts).toBe(0);
  });
  it("lost start followed by restart and expired original JWT uses accepted-only continuation", async () => {
    const f = await fixture();
    const r = f.create();
    await r.ensure(key);
    const original = f.row?.encryptedSecrets;
    f.dropStart();
    expect((await f.step(r)).phase).toBe("start_unknown");
    expect(f.row?.encryptedSecrets).toBe(original);
    f.shift(600000);
    expect((await f.step(f.create())).phase).toBe("awaiting_consent");
    expect(f.starts).toBe(1);
  });
  it("stage failure never sends confirm", async () => {
    const f = await fixture();
    const r = f.create();
    await r.ensure(key);
    await f.step(r);
    f.rejectStage();
    await f.step(r);
    expect(f.confirms).toBe(0);
    expect(f.row?.state.phase).toBe("awaiting_consent");
  });
  it("lost confirm plus restart reuses the same committed key without another poll", async () => {
    const f = await fixture();
    const r = f.create();
    await r.ensure(key);
    await f.step(r);
    await f.step(r);
    const id = f.row?.state.credentialId;
    f.dropConfirm();
    expect((await f.step(r)).phase).toBe("confirm_unknown");
    expect((await f.step(f.create())).phase).toBe("connected");
    expect(f.row?.state.credentialId).toBe(id);
    expect(f.polls).toBe(1);
    expect(f.confirms).toBe(2);
    expect(f.starts).toBe(1);
  });
  it("publication response loss converges from the already committed connection", async () => {
    const f = await fixture();
    const r = f.create();
    await r.ensure(key);
    await f.step(r);
    await f.step(r);
    f.dropPublish();
    await f.step(r);
    expect((await f.step(f.create())).phase).toBe("connected");
    expect(f.confirms).toBe(1);
  });
  it("disconnect fences a delayed accepted response", async () => {
    const f = await fixture();
    const r = f.create();
    const v = await r.ensure(key);
    const handle = { operationId: v.linkId, key };
    const lease = await f.store.acquire(handle, crypto.randomUUID());
    if (!lease?.leaseOwner) throw new Error("lease");
    await r.disconnect(handle, lease.revision);
    expect(
      await f.store.update(
        {
          operationId: v.linkId,
          key,
          revision: lease.revision,
          fence: lease.fence,
          leaseOwner: lease.leaseOwner,
        },
        { state: { ...lease.state, phase: "connected" } }
      )
    ).toBeNull();
  });
  it("unknown pre-key retention expires without a new operation", async () => {
    const f = await fixture();
    const r = f.create();
    const v = await r.ensure(key);
    f.shift(25 * 3600000);
    const result = await r.advance({ operationId: v.linkId, key });
    expect(result.phase).toBe("expired_unknown");
    expect(f.row?.encryptedSecrets).toBeNull();
    expect(f.starts).toBe(0);
  });
  it("serialized continuation404 after original expiry fences and erases pre-key custody before fallback, without automatic restart", async () => {
    const f = await fixture(), r = f.create();
    const first = await r.ensure(key), h = { operationId: first.linkId, key };
    const original = f.row;
    if (!original) throw new Error("missing intent");
    f.shift(11 * 60000);
    const result = await r.advance(h);
    expect(result.phase).toBe("expired_unknown");
    expect(f.row?.encryptedSecrets).toBeNull();
    expect(f.row?.state.nonacceptanceObservedAt).toBeTruthy();
    expect(f.row?.fence).toBeGreaterThan(original.fence);
    expect(f.starts).toBe(0);
    await r.advance(h); expect(f.starts).toBe(0);
    const next = await r.reenroll(h, result.revision);
    expect(next.linkId).not.toBe(first.linkId);
    expect(f.row?.state.intent).toMatchObject({ generation: 1, expectedGeneration: 0, expectedOperationId: null });
  });
  it("original-start404 and pre-expiry receiver observations retain encrypted uncertainty", async () => {
    const f = await fixture(), r = f.create();
    const first = await r.ensure(key), h = { operationId: first.linkId, key };
    const original = f.row;
    if (!original) throw new Error("missing intent");
    f.missingAt(new Date(original.state.intent.originalStartExp * 1000 + 1000).toISOString());
    expect((await r.advance(h)).phase).toBe("start_unknown"); // This was a start, not authenticated continuation reconciliation.
    expect(f.row?.encryptedSecrets).toBe(original.encryptedSecrets);
    f.shift(11 * 60000);
    f.missingAt(new Date(original.state.intent.originalStartExp * 1000 - 1000).toISOString());
    expect((await r.advance(h)).phase).toBe("start_unknown");
    expect(f.row?.encryptedSecrets).toBe(original.encryptedSecrets);
    expect(f.row?.state.nonacceptanceObservedAt).toBeUndefined();
    expect(f.starts).toBe(0);
  });
  it("explicit reenroll reconciles a never-accepted expired intent without inventing a predecessor", async () => {
    const f = await fixture(); const r = f.create();
    const first = await r.ensure(key);
    f.shift(25 * 3600000);
    await r.advance({ operationId: first.linkId, key });
    const revision = f.row!.revision;
    const next = await r.reenroll({ operationId: first.linkId, key }, revision);
    expect(next.linkId).not.toBe(first.linkId);
    expect(f.row!.state.intent).toMatchObject({ generation: 1, expectedGeneration: 0, expectedOperationId: null });
    expect((await f.step(r)).phase).toBe("awaiting_consent");
    expect(f.starts).toBe(1);
  });
  it("accepted but lost start keeps the authenticated predecessor on explicit reenroll", async () => {
    const f = await fixture(); const r = f.create();
    const first = await r.ensure(key); f.dropStart(); await f.step(r);
    f.shift(25 * 3600000); await r.advance({ operationId: first.linkId, key });
    f.terminalRemote();
    await r.reenroll({ operationId: first.linkId, key }, f.row!.revision);
    expect(f.row!.state.intent).toMatchObject({ generation: 2, expectedGeneration: 1, expectedOperationId: first.linkId });
    expect((await f.step(r)).phase).toBe("awaiting_consent");
    expect(f.starts).toBe(2);
  });
  it("unknown remote effects and a still-valid original start never authorize a fresh operation", async () => {
    const f = await fixture(); const r = f.create();
    const first = await r.ensure(key); const h = { operationId: first.linkId, key };
    await r.disconnect(h, f.row!.revision);
    await expect(r.reenroll(h, f.row!.revision)).rejects.toThrow("remote_reconciliation_required");
    expect(f.row!.operationId).toBe(first.linkId);
    f.shift(25 * 3600000); f.ambiguousRemote();
    await expect(r.reenroll(h, f.row!.revision)).rejects.toThrow("origin_unreachable");
    expect(f.row!.operationId).toBe(first.linkId);
    expect(f.starts).toBe(0);
  });
  it("five confirmation throttles pause and explicit resume confirms the same staged credential", async () => {
    const f = await fixture(); const r = f.create();
    const first = await r.ensure(key); await f.step(r); await f.step(r);
    const credential = f.row!.state.credentialId;
    f.throttle(true);
    for (let n = 0; n < 5; n++) await f.step(r);
    expect(f.row!.state).toMatchObject({ attempts: 5, paused: true, phase: "confirm_unknown", credentialId: credential });
    await f.step(r); expect(f.confirms).toBe(5);
    f.throttle(false);
    expect((await r.advance({ operationId: first.linkId, key }, { resumeRevision: f.row!.revision })).phase).toBe("connected");
    expect(f.confirms).toBe(6); expect(f.polls).toBe(1); expect(f.starts).toBe(1);
    expect(f.row!.state.credentialId).toBe(credential);
  });
  it("redacts decoded escaped credentials in knowledge values, arrays and property names", async () => {
    const f = await fixture(); const r = f.create();
    const first = await r.ensure(key); await f.step(r); await f.step(r); await f.step(r);
    const other = (await mintKey()).token;
    const legacy = "cogni_ag_sk_v1_not-a-real-credential";
    const escaped = JSON.stringify({ [f.bearer]: { nested: [f.bearer, other, legacy], title: "Useful rule" } })
      .replaceAll("cogni_", "\\u0063ogni_");
    expect(escaped).not.toContain(f.bearer);
    const handlers = createServiceLinkHandlers({ requester: r, store: f.store, vault: f.vault,
      keyForAlias: () => key, handleForId: async () => ({ operationId: first.linkId, key }), allowedEntries: ["rule"],
      fetch: async (_url, init) => { expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${f.bearer}`); return new Response(escaped); },
    });
    const result = await handlers.knowledge(first.linkId, "rule");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ "[REDACTED]": { nested: ["[REDACTED]", "[REDACTED]", "[REDACTED]"], title: "Useful rule" } });
    for (const token of [f.bearer, other, legacy]) expect(JSON.stringify(result)).not.toContain(token);
    expect(result.headers["cache-control"]).toBe("no-store");
  });
  it("Off between stage and confirm traverses the real HTTP mapping and On confirms the same key", async () => {
    const f=await fixture(), r=f.create(); await r.ensure(key); await f.step(r); await f.step(r);
    const staged=f.row?.state.credentialId, token=f.bearer;
    f.refuseConfirm("permission_off"); await f.step(r);
    expect(f.row?.state).toMatchObject({phase:"confirm_unknown",error:"permission_off",nextAction:"confirm",attempts:0,paused:false});
    expect(f.bearer).toBe(token); f.refuseConfirm(null);
    expect((await f.step(r)).phase).toBe("connected");
    expect(f.row?.state.credentialId).toBe(staged); expect(f.polls).toBe(1); expect(f.starts).toBe(1);
  });
  it.each(["expired","revoked"] as const)("typed %s confirmation race reconciles terminal410 without erasing staged custody", async reason => {
    const f=await fixture(), r=f.create(); const first=await r.ensure(key); await f.step(r); await f.step(r);
    const staged=f.row?.state.credentialId, token=f.bearer;
    f.shift(25*3600000); f.refuseConfirm(reason); await f.step(r);
    expect(f.row?.state.nextAction).toBe("continue");
    f.terminalRemote(); expect((await f.step(r)).phase).toBe("needs_reenroll");
    expect(f.row?.state).toMatchObject({credentialId:staged,connectionId:"stage",nextAction:"none",paused:false});
    expect(f.row?.state.terminalObservedAt).toBeTruthy(); expect(f.bearer).toBe(token); expect(f.polls).toBe(1);
    const terminal=f.row; if (!terminal) throw new Error("missing terminal");
    await r.reenroll({operationId:first.linkId,key},terminal.revision);
    expect(f.row?.state.intent).toMatchObject({generation:2,expectedGeneration:1,expectedOperationId:first.linkId});
  });
  it("untyped proxy410 and unknown409 retain staged uncertainty rather than claiming terminal or Off", async () => {
    const f=await fixture(), r=f.create(); await r.ensure(key); await f.step(r); await f.step(r);
    f.refuseConfirm("expired"); await f.step(r); f.terminalRemote(); f.untypedTerminal(); await f.step(r);
    expect(f.row?.state).toMatchObject({phase:"confirm_unknown",attempts:1});
    expect(f.row?.state.terminalObservedAt).toBeUndefined(); expect(f.row?.state.connectionId).toBe("stage");
    const g=await fixture(), s=g.create(); await s.ensure(key); await g.step(s); await g.step(s); g.unknownConfirm(); await g.step(s);
    expect(g.row?.state).toMatchObject({phase:"confirm_unknown",error:"protocol_error",attempts:1});
  });
  it("lost successful confirmation remains status-recoverable after receipt expiry and retries the same key", async () => {
    const f=await fixture(), r=f.create(); await r.ensure(key); await f.step(r); await f.step(r); f.dropConfirm(); await f.step(r);
    const token=f.bearer; f.shift(2*86400000); f.rejectConfirmAuth(true); await f.step(r); f.rejectConfirmAuth(false);
    await f.step(r); expect(f.row?.state.nextAction).toBe("confirm");
    expect((await f.step(r)).phase).toBe("connected"); expect(f.bearer).toBe(token); expect(f.polls).toBe(1); expect(f.starts).toBe(1);
  });
  it("receiver10s ahead can stage and confirm the maximum30d/14d policy without quarantine", async () => {
    const f=await fixture(), r=f.create(); f.skewTarget(10000); await r.ensure(key); await f.step(r);
    expect((await f.step(r)).phase).toBe("key_staged");
    expect((await f.step(r)).phase).toBe("connected");
    expect(f.row?.state.quarantined).not.toBe(true); expect(f.row?.state.paused).toBe(false);
  });
  it("receiver time never excuses an oversized later policy or authorizes custody erasure", async () => {
    const f=await fixture(), r=f.create(); f.skewTarget(10000); await r.ensure(key); await f.step(r); await f.step(r);
    const staged=f.row?.state.credentialId, token=f.bearer;
    f.oversizedConfirm(); await f.step(r);
    expect(f.row?.state).toMatchObject({phase:"confirm_unknown",paused:true,quarantined:true,error:"protocol_error",credentialId:staged});
    expect(f.bearer).toBe(token); expect(f.polls).toBe(1);
  });
  it("custody cipher rejects a different service/environment/operation AAD", async () => {
    const f = await fixture();
    const encrypted = await f.cipher.seal("secret", JSON.stringify(key));
    await expect(
      f.cipher.open(encrypted, JSON.stringify({ ...key, service: "other" }))
    ).rejects.toThrow();
  });
});
