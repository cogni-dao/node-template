// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Requester half of service enrollment (story.0038 T5) against the PROVIDER half in one process: the client signs, the provider's real verifier
 * checks the signature, the admin's click is played on the memory store, the client opens the sealed key and confirms it. No network, no database.
 */

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  jwtVerify,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AdminCheck,
  type AgentGrantsStore,
  authorizeCaller,
  ROUTE_ONLY_CAPABILITIES,
} from "../src";
import {
  confirmCredential,
  hashAgentKey,
  verifyBearer,
} from "../src/credentials";
import { mintKey } from "../src/credentials/service";
import {
  enrollmentHttp,
  pollServiceEnrollment,
  pollServiceEnrollmentOperation,
  requestServiceEnrollment,
  requestServiceEnrollmentOperation,
  SERVICE_ENROLLMENT_TYP,
  sealToJwk,
  serviceEnrollmentAudience,
  serviceEnrollmentClaims,
} from "../src/enrollment";
import {
  buildEnrollmentClaims,
  createEnrollmentSigner,
  createEnrollmentTransport,
  ENROLLMENT_CONFIRM_PATH,
  ENROLLMENT_REQUEST_PATH,
  ENROLLMENT_TOKEN_PATH,
  EnrollmentClientError,
  type EnrollmentTransport,
  enrollService,
  generateLinkKeypair,
  pollEnrollment,
  readBoundedBody,
  startEnrollment,
  unsealServiceKey,
} from "../src/enrollment/client";
import { memoryEnrollmentStore } from "./enrollment-memory-store";
import { memoryStore } from "./memory-store";

const NODE_ID = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "https://node-x.example";
const ISSUER = "https://home.example";
const SCOPE = "knowledge:read";
const KID = "home-key-1";

let signingKey: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: Parameters<typeof requestServiceEnrollment>[1];
let uuidCounter = 0;
const newId = (): string => {
  uuidCounter += 1;
  return `55555555-5555-4555-8555-${String(uuidCounter).padStart(12, "0")}`;
};

beforeAll(async () => {
  signingKey = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwks = createLocalJWKSet({
    keys: [
      { ...(await exportJWK(signingKey.publicKey)), alg: "EdDSA", kid: KID },
    ],
  });
  // Archived v1 utility compatibility only. The actual target verifier is v2-only and tested in enrollment-verify.
  verify = async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ["EdDSA"],
        typ: SERVICE_ENROLLMENT_TYP,
        issuer: ISSUER,
        audience: serviceEnrollmentAudience(NODE_ID),
      });
      const claims = serviceEnrollmentClaims.parse(payload);
      if (claims.service !== "git-review" || claims.scopes[0] !== SCOPE)
        return { ok: false, reason: "invalid_token" };
      return { ok: true, claims };
    } catch {
      return { ok: false, reason: "invalid_token" };
    }
  };
});

const jsonResponse = (res: {
  status: number;
  body: unknown;
  headers: Readonly<Record<string, string>>;
}): Response =>
  new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { "content-type": "application/json", ...res.headers },
  });

/** The served node, in process: the three routes the client calls, wired exactly as a node's route files wire the package. */
function servedNode(m: ReturnType<typeof memoryEnrollmentStore>) {
  const calls: string[] = [];
  const fetchImpl = (async (
    input: URL | string,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(input.toString());
    calls.push(url.pathname);
    expect(url.origin).toBe(ORIGIN);
    expect(init?.redirect).toBe("manual");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    if (url.pathname === ENROLLMENT_REQUEST_PATH) {
      const input = requestServiceEnrollmentOperation.input.parse(body);
      const result = await requestServiceEnrollment(m.store, verify, {
        token: input.token,
        askableScopes: [SCOPE],
      });
      return jsonResponse(enrollmentHttp({ op: "request", result }));
    }
    if (url.pathname === ENROLLMENT_TOKEN_PATH) {
      const input = pollServiceEnrollmentOperation.input.parse(body);
      return jsonResponse(
        enrollmentHttp({
          op: "poll",
          result: await pollServiceEnrollment(m.store, {
            deviceCode: input.deviceCode,
          }),
        })
      );
    }
    if (url.pathname === ENROLLMENT_CONFIRM_PATH) {
      const bearer = String(
        (init?.headers as Record<string, string>)?.authorization ?? ""
      ).replace(/^Bearer /, "");
      const who = await verifyBearer(m.credentials, bearer, [
        "pending",
        "active",
      ]);
      if (!who.ok)
        return jsonResponse({
          status: 401,
          body: { error: "invalid" },
          headers: {},
        });
      await confirmCredential(m.credentials, {
        credentialId: who.credentialId,
      });
      return jsonResponse({ status: 200, body: { ok: true }, headers: {} });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const harness = () => {
  const m = memoryEnrollmentStore();
  const node = servedNode(m);
  const transport = createEnrollmentTransport({ fetch: node.fetch });
  const signer = createEnrollmentSigner({
    kid: KID,
    key: signingKey.privateKey,
  });
  const common = {
    transport,
    signer,
    issuer: ISSUER,
    origin: ORIGIN,
    nodeId: NODE_ID,
    service: "git-review",
    scope: SCOPE,
    newId,
  };
  /** The admin's click and the poll interval passing, played while the client waits. */
  const waitForAdmin =
    (ms: number[] = []) =>
    async (waited: number) => {
      ms.push(waited);
      const principal = m.principals[0];
      if (principal) m.approve(principal.userId, SCOPE);
      for (const e of m.enrollments)
        if (e.lastPolledAt !== null) e.lastPolledAt = m.clock.now - 60_000;
    };
  /** The `knowledge.read` door over the provider's rows: the grants store reads the enrollment store's principals and role rows. */
  const grants = memoryStore();
  const store: AgentGrantsStore = {
    ...grants,
    isServicePrincipal: async (id) => m.principals.some((p) => p.userId === id),
    hasLiveRole: async (id, scope) =>
      m.roles.some(
        (r) =>
          r.principal === id && r.scope === scope && r.approved && !r.revoked
      ),
    liveScopes: async (id, scopes) =>
      scopes.filter((scope) =>
        m.roles.some(
          (r) =>
            r.principal === id && r.scope === scope && r.approved && !r.revoked
        )
      ),
  };
  const cap = ROUTE_ONLY_CAPABILITIES["knowledge.read"];
  if (!cap) throw new Error("knowledge.read must be declared");
  const deny: AdminCheck = async () => "denied";
  const door = (userId: string) =>
    authorizeCaller(store, deny, {
      userId,
      via: "bearer",
      requires: cap.requires,
      serviceKeyedOnly: cap.serviceKeyedOnly,
    });
  return { m, node, transport, signer, common, waitForAdmin, door };
};

describe("requester vs provider: round trip", () => {
  it("enrolls, 403 until On, key opened and equal to the provider's hash, read passes the door, then Off is 403", async () => {
    const h = harness();
    const stored: string[] = [];
    const waits: number[] = [];
    const doors: unknown[] = [];
    const clickOn = h.waitForAdmin(waits);
    const result = await enrollService({
      ...h.common,
      store: async (k) => void stored.push(k),
      sleep: async (ms) => {
        // The admin has not clicked yet: the enrolled service's read is refused at the door.
        const early = h.m.principals[0];
        if (early) doors.push(await h.door(early.userId));
        await clickOn(ms);
      },
    });
    if (!result.ok) throw new Error(`enroll: ${result.reason}`);
    expect(doors).toEqual([
      expect.objectContaining({ decision: "deny", reason: "no_role" }),
    ]);

    // One principal, one ask, approved by the played click.
    expect(h.m.principals).toHaveLength(1);
    expect(waits).toEqual([5000]); // authorization_pending once, then the click

    // The key the client holds IS the key the provider hashed, and it authenticates as the enrolled principal.
    expect(stored).toEqual([result.apiKey]);
    const row = h.m.credentialRows.find((r) => r.id === result.credentialId);
    expect(row?.tokenHash).toBe(await hashAgentKey(result.apiKey));
    const who = await verifyBearer(h.m.credentials, result.apiKey);
    expect(who).toMatchObject({ ok: true, state: "active" });
    if (!who.ok) throw new Error("key does not verify");
    expect(h.node.calls).toEqual([
      ENROLLMENT_REQUEST_PATH,
      ENROLLMENT_TOKEN_PATH,
      ENROLLMENT_TOKEN_PATH,
      ENROLLMENT_CONFIRM_PATH,
    ]);

    // A knowledge read with that key passes the door after the click ...
    expect(await h.door(who.userId)).toMatchObject({
      decision: "allow",
      basis: "role",
    });
    // ... and is 403 the moment the admin turns it Off: the next read is refused.
    h.m.switchOff(who.userId, SCOPE);
    expect(await h.door(who.userId)).toMatchObject({
      decision: "deny",
      code: "policy_denied",
      reason: "no_role",
    });
  });

  it("a key of an enrolled service belongs to ONE principal named <issuer>#<service>", async () => {
    const h = harness();
    const result = await enrollService({
      ...h.common,
      sleep: h.waitForAdmin(),
    });
    expect(result.ok).toBe(true);
    expect(h.m.principals.map((p) => p.serviceKey)).toEqual([
      `${ISSUER}#git-review`,
    ]);
  });

  it("a second poll inside the interval is slow_down: the loop waits 5 s longer and still ends with the key", async () => {
    const h = harness();
    const waits: number[] = [];
    const principalClick = async (waited: number) => {
      waits.push(waited);
      const principal = h.m.principals[0];
      if (waits.length === 2 && principal) h.m.approve(principal.userId, SCOPE);
      if (waits.length === 3)
        for (const e of h.m.enrollments)
          if (e.lastPolledAt !== null) e.lastPolledAt = h.m.clock.now - 60_000;
    };
    const result = await enrollService({ ...h.common, sleep: principalClick });
    expect(result.ok).toBe(true);
    expect(waits.slice(0, 2)).toEqual([5000, 10_000]);
  });

  it("a dismissed ask ends the loop with access_denied and no key", async () => {
    const h = harness();
    const result = await enrollService({
      ...h.common,
      sleep: async () => {
        const principal = h.m.principals[0];
        if (principal) h.m.dismiss(principal.userId, SCOPE);
        for (const e of h.m.enrollments)
          if (e.lastPolledAt !== null) e.lastPolledAt = h.m.clock.now - 60_000;
      },
    });
    expect(result).toEqual({ ok: false, reason: "access_denied" });
    expect(h.m.credentialRows).toHaveLength(0);
  });

  it("the same token twice is refused by the provider: replayed_token", async () => {
    const h = harness();
    const keypair = await generateLinkKeypair();
    const token = await h.signer.sign(
      buildEnrollmentClaims({
        issuer: ISSUER,
        nodeId: NODE_ID,
        service: "git-review",
        scope: SCOPE,
        cnfPublicJwk: keypair.publicJwk,
        jti: newId(),
        now: new Date(),
      })
    );
    await h.transport.postEnrollment(ORIGIN, token);
    await expect(
      h.transport.postEnrollment(ORIGIN, token)
    ).rejects.toMatchObject({ code: "replayed_token", status: 401 });
  });

  it("a service the home may not sign for is refused as enrollment_rejected", async () => {
    const h = harness();
    await expect(
      startEnrollment({ ...h.common, service: "other-service" })
    ).rejects.toMatchObject({ code: "enrollment_rejected", status: 401 });
  });
});

describe("signer", () => {
  it("a signBytes signer makes a token the provider's verifier accepts", async () => {
    const signer = createEnrollmentSigner({
      kid: KID,
      signBytes: async (input) =>
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            signingKey.privateKey as CryptoKey,
            input
          )
        ),
    });
    const keypair = await generateLinkKeypair();
    const claims = buildEnrollmentClaims({
      issuer: ISSUER,
      nodeId: NODE_ID,
      service: "git-review",
      scope: SCOPE,
      cnfPublicJwk: keypair.publicJwk,
      jti: newId(),
      now: new Date(),
    });
    expect(claims.aud).toBe(serviceEnrollmentAudience(NODE_ID));
    const result = await verify(await signer.sign(claims));
    expect(result).toMatchObject({
      ok: true,
      claims: { service: "git-review", scopes: [SCOPE], iss: ISSUER },
    });
  });

  it("refuses to sign a lifetime above 10 minutes or a private cnf key", async () => {
    const signer = createEnrollmentSigner({
      kid: KID,
      key: signingKey.privateKey,
    });
    const keypair = await generateLinkKeypair();
    const claims = buildEnrollmentClaims({
      issuer: ISSUER,
      nodeId: NODE_ID,
      service: "git-review",
      scope: SCOPE,
      cnfPublicJwk: keypair.publicJwk,
      jti: newId(),
      now: new Date(),
      ttlSec: 86_400,
    });
    expect(claims.exp - claims.iat).toBe(600);
    await expect(
      signer.sign({ ...claims, exp: claims.iat + 601 })
    ).rejects.toThrow();
    await expect(
      signer.sign({
        ...claims,
        cnf: {
          jwk: { ...keypair.publicJwk, d: (keypair.privateJwk as JWK).d },
        } as never,
      })
    ).rejects.toThrow();
  });
});

describe("unseal", () => {
  it("opens only with the matching private key and only a well-formed key", async () => {
    const mine = await generateLinkKeypair();
    const other = await generateLinkKeypair();
    const { token } = await mintKey();
    expect(
      await unsealServiceKey(
        await sealToJwk(token, mine.publicJwk),
        mine.privateJwk
      )
    ).toBe(token);
    await expect(
      unsealServiceKey(await sealToJwk(token, mine.publicJwk), other.privateJwk)
    ).rejects.toThrow("sealed_key_unreadable");
    await expect(
      unsealServiceKey(
        await sealToJwk("not-a-key", mine.publicJwk),
        mine.privateJwk
      )
    ).rejects.toThrow("sealed_key_unreadable");
    await expect(
      unsealServiceKey("x".repeat(20_000), mine.privateJwk)
    ).rejects.toThrow("sealed_key_unreadable");
  });
});

describe("transport and poll loop against a hostile or broken node", () => {
  const transportFor = (
    impl: (url: URL, init?: RequestInit) => Response | Promise<Response>,
    options = {}
  ) =>
    createEnrollmentTransport({
      fetch: (async (u: URL | string, i?: RequestInit) =>
        impl(new URL(u.toString()), i)) as typeof fetch,
      ...options,
    });

  it("clamps the interval and the expiry the node returns", async () => {
    const t = transportFor(() =>
      Response.json({
        deviceCode: "d".repeat(43),
        expires_in: 999_999_999,
        interval: 1,
      })
    );
    expect(await t.postEnrollment(ORIGIN, "t")).toEqual({
      deviceCode: "d".repeat(43),
      expiresInS: 86_400,
      intervalS: 5,
    });
    const slow = transportFor(() =>
      Response.json({
        deviceCode: "d".repeat(43),
        expires_in: 1,
        interval: 99_999,
      })
    );
    expect(await slow.postEnrollment(ORIGIN, "t")).toMatchObject({
      expiresInS: 60,
      intervalS: 60,
    });
  });

  it("refuses a non-https origin without a call, a 5xx as origin_unreachable and a malformed 200 as bad_response", async () => {
    let calls = 0;
    const t = transportFor(() => {
      calls += 1;
      return new Response("{}", { status: 503 });
    });
    await expect(
      t.postEnrollment("http://node-x.example", "t")
    ).rejects.toMatchObject({ code: "origin_unreachable" });
    expect(calls).toBe(0);
    await expect(t.postEnrollment(ORIGIN, "t")).rejects.toMatchObject({
      code: "origin_unreachable",
      status: 503,
    });
    await expect(
      transportFor(() => Response.json({ nope: true })).postEnrollment(
        ORIGIN,
        "t"
      )
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("a redirect is never followed: the request carries redirect manual and a 3xx is a rejection", async () => {
    let redirect: RequestRedirect | undefined;
    const t = transportFor((_u, init) => {
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example" },
      });
    });
    await expect(t.postEnrollment(ORIGIN, "t")).rejects.toMatchObject({
      code: "enrollment_rejected",
      status: 302,
    });
    expect(redirect).toBe("manual");
  });

  it("the response cap is enforced while reading: a declared oversize and an endless stream both stop", async () => {
    const declared = new Response("{}", {
      headers: { "content-length": String(10 * 1024 * 1024) },
    });
    expect(await readBoundedBody(declared, 1024)).toEqual({
      ok: false,
      reason: "too_large",
    });
    let pulled = 0;
    const endless = new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(512));
        },
      })
    );
    expect(await readBoundedBody(endless, 2048)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(pulled).toBeLessThan(10);
    await expect(
      transportFor(() => new Response("x".repeat(70_000))).postEnrollment(
        ORIGIN,
        "t"
      )
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("maps the RFC 8628 errors, treats 429 as slow_down and an unknown error as bad_response", async () => {
    for (const error of [
      "authorization_pending",
      "slow_down",
      "access_denied",
      "expired_token",
    ] as const) {
      expect(
        await transportFor(() =>
          Response.json({ error }, { status: 400 })
        ).pollToken(ORIGIN, "c")
      ).toEqual({ kind: error });
    }
    expect(
      await transportFor(() => new Response("{}", { status: 429 })).pollToken(
        ORIGIN,
        "c"
      )
    ).toEqual({ kind: "slow_down" });
    await expect(
      transportFor(() =>
        Response.json({ error: "mystery" }, { status: 400 })
      ).pollToken(ORIGIN, "c")
    ).rejects.toBeInstanceOf(EnrollmentClientError);
  });

  const fakeTransport = (
    results: Array<
      Awaited<ReturnType<EnrollmentTransport["pollToken"]>> | Error
    >
  ): Pick<EnrollmentTransport, "pollToken"> => {
    let i = 0;
    return {
      async pollToken() {
        const next = results[Math.min(i, results.length - 1)];
        i += 1;
        if (next instanceof Error) throw next;
        return next as never;
      },
    };
  };

  it("the loop stops at the clamped expiry and never waits less than the clamped interval", async () => {
    let now = 0;
    const waits: number[] = [];
    const result = await pollEnrollment({
      transport: fakeTransport([{ kind: "authorization_pending" }]),
      origin: ORIGIN,
      deviceCode: "c",
      intervalS: 1, // clamped up to 5
      expiresInS: 1, // clamped up to 60
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    expect(result).toEqual({ kind: "expired_token" });
    expect(new Set(waits)).toEqual(new Set([5000]));
    expect(waits).toHaveLength(12);
  });

  it("slow_down adds 5 s each time up to the 60 s ceiling", async () => {
    let now = 0;
    const waits: number[] = [];
    await pollEnrollment({
      transport: fakeTransport([{ kind: "slow_down" }]),
      origin: ORIGIN,
      deviceCode: "c",
      intervalS: 55,
      expiresInS: 600,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    expect(waits.slice(0, 3)).toEqual([60_000, 60_000, 60_000]);
  });

  it("transient failures are retried, then thrown after the limit; an abort ends the loop", async () => {
    const down = new EnrollmentClientError("origin_unreachable", 503);
    const noSleep = async () => {};
    expect(
      await pollEnrollment({
        transport: fakeTransport([down, down, { kind: "access_denied" }]),
        origin: ORIGIN,
        deviceCode: "c",
        intervalS: 5,
        expiresInS: 600,
        sleep: noSleep,
      })
    ).toEqual({ kind: "access_denied" });
    await expect(
      pollEnrollment({
        transport: fakeTransport([down]),
        origin: ORIGIN,
        deviceCode: "c",
        intervalS: 5,
        expiresInS: 600,
        sleep: noSleep,
        maxTransientFailures: 3,
      })
    ).rejects.toBe(down);
    const controller = new AbortController();
    controller.abort();
    expect(
      await pollEnrollment({
        transport: fakeTransport([{ kind: "authorization_pending" }]),
        origin: ORIGIN,
        deviceCode: "c",
        intervalS: 5,
        expiresInS: 600,
        signal: controller.signal,
      })
    ).toEqual({
      kind: "aborted",
    });
  });
});
