// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Behavioral crash/concurrency fixtures; SQL lock/FK proof runs separately in component CI. */
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { mintKey } from "../src/credentials/service";
import {
  type ConnectionKey,
  createEnrollmentTokenVerifier,
  ENROLLMENT_PROTOCOL,
  type EnrollmentProof,
  sealToJwk,
} from "../src/enrollment";
import { EnrollmentClientError } from "../src/enrollment/client/transport";
import {
  createCustodyCipher,
  createEnrollmentProofSigner,
  createEnrollmentRequester,
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
    failReserve = false;
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
    now: () => new Date(time),
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
        secretDeadline: new Date(time + 44 * 86400000).toISOString(),
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
  const transport = {
    async postProof(tokenOrigin: string, token: string) {
      expect(tokenOrigin).toBe(key.target.origin);
      expect(row?.encryptedSecrets).toBeTruthy(); // Intent committed before start/continue while pre-key.
      const checked = await verifier(token);
      if (!checked.ok) throw new Error("bad proof");
      const p = checked.claims;
      if (!accepted) {
        if (p.op !== "start")
          throw new EnrollmentClientError(
            "enrollment_rejected",
            404,
            new Date(time).toISOString()
          );
        starts++;
        accepted = p;
        const at = new Date(time).toISOString();
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
            recoveryExpiresAt: new Date(time + 86400000).toISOString(),
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
            pendingExpiresAt: new Date(time + 900000).toISOString(),
            expiresAt: new Date(time + 30 * 86400000).toISOString(),
            renewUntil: new Date(time + 44 * 86400000).toISOString(),
          }),
          accepted.cnf.jwk
        );
      }
      return {
        kind: "issued" as const,
        sealedKey,
        credentialId,
        pendingExpiresAt: new Date(time + 900000).toISOString(),
      };
    },
    async confirmStaged(origin: string, token: string) {
      expect(origin).toBe(key.target.origin);
      confirms++;
      expect(row?.state.phase).toBe("confirm_unknown");
      expect(row?.state.connectionId).toBe("stage");
      expect(token).toBe(bearer);
      connected = true;
      if (dropConfirm) {
        dropConfirm = false;
        throw new EnrollmentClientError("origin_unreachable");
      }
      return {
        status: 200,
        credentialId,
        expiresAt: new Date(time + 29 * 86400000).toISOString(),
        renewUntil: new Date(time + 43 * 86400000).toISOString(),
      };
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
  it("custody cipher rejects a different service/environment/operation AAD", async () => {
    const f = await fixture();
    const encrypted = await f.cipher.seal("secret", JSON.stringify(key));
    await expect(
      f.cipher.open(encrypted, JSON.stringify({ ...key, service: "other" }))
    ).rejects.toThrow();
  });
});
