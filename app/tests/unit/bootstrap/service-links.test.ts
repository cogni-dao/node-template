// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/service-links`
 * Purpose: The outbound side of story.0038 phase 2: the ask posts one signed assertion to the configured origin only, an unknown alias or a missing signer sends nothing, and a
 *   remote knowledge read signs as service `node-ai` for the target's node id with scope `knowledge:read`.
 * Side-effects: none
 */

import type { ServiceAssertionSigner } from "@cogni/agent-grants/service-auth";
import { describe, expect, it, vi } from "vitest";
import { createServiceLinks } from "@/bootstrap/service-links";

const TARGETS = [{ alias: "toks5", nodeId: "node-toks5", origin: "https://toks5.example.org" }];
const log = { info: vi.fn(), warn: vi.fn() } as never;

const signer = () => {
  const authorizationHeader = vi.fn(async () => "Bearer jwt-from-signer");
  return { signer: { authorizationHeader, sign: vi.fn(), jwks: vi.fn() } as unknown as ServiceAssertionSigner, authorizationHeader };
};

describe("service links", () => {
  it("ask signs as node-ai for the target node id and posts { scope } to the configured enrollment route only", async () => {
    const s = signer();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    }) as typeof fetch;
    const links = createServiceLinks({ targets: TARGETS, signer: async () => s.signer, log, fetchImpl });
    expect(await links.ask("toks5", "knowledge:read")).toEqual({ ok: true, alias: "toks5", status: "pending", httpStatus: 201 });
    expect(s.authorizationHeader).toHaveBeenCalledWith({ service: "node-ai", audienceNodeId: "node-toks5", scope: "knowledge:read" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://toks5.example.org/api/v1/public/agent/service-enrollments");
    expect(calls[0]?.init).toMatchObject({ method: "POST", redirect: "manual", body: JSON.stringify({ scope: "knowledge:read" }) });
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer jwt-from-signer");
  });

  it("a refusal from the target is reported with its status and no status word", async () => {
    const s = signer();
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const links = createServiceLinks({ targets: TARGETS, signer: async () => s.signer, log, fetchImpl });
    expect(await links.ask("toks5", "knowledge:read")).toEqual({ ok: true, alias: "toks5", status: null, httpStatus: 401 });
  });

  it("an unknown alias, a missing signer and a network failure send nothing unsigned", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const s = signer();
    const configured = createServiceLinks({ targets: TARGETS, signer: async () => s.signer, log, fetchImpl });
    expect(await configured.ask("nope", "knowledge:read")).toEqual({ ok: false, reason: "unknown_alias" });
    const unsigned = createServiceLinks({ targets: TARGETS, signer: async () => null, log, fetchImpl });
    expect(await unsigned.ask("toks5", "knowledge:read")).toEqual({ ok: false, reason: "no_signer" });
    await expect(unsigned.remoteKnowledge.get("toks5", "k1")).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const broken = createServiceLinks({ targets: TARGETS, signer: async () => s.signer, log, fetchImpl: (async () => Promise.reject(new TypeError("net"))) as typeof fetch });
    expect(await broken.ask("toks5", "knowledge:read")).toEqual({ ok: false, reason: "unreachable" });
  });

  it("a remote knowledge read signs for the target's node id with scope knowledge:read, once per request", async () => {
    const s = signer();
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const links = createServiceLinks({ targets: TARGETS, signer: async () => s.signer, log, fetchImpl });
    expect(await links.remoteKnowledge.get("toks5", "k1")).toBeNull();
    expect(s.authorizationHeader).toHaveBeenCalledTimes(1);
    expect(s.authorizationHeader).toHaveBeenCalledWith({ service: "node-ai", audienceNodeId: "node-toks5", scope: "knowledge:read" });
    expect(links.targets).toHaveLength(1);
  });

  it("no configured targets means no target and every alias is unknown", async () => {
    const links = createServiceLinks({ targets: [], signer: async () => null, log });
    expect(links.targets).toEqual([]);
    await expect(links.remoteKnowledge.get("toks5", "k1")).rejects.toMatchObject({ code: "unknown_alias" });
  });
});

describe("the node AI's own ask (a 401 to a signed remote read)", () => {
  it("sends one signed ask and logs service_link.asked with alias, scope and status, never a token", async () => {
    const s = signer();
    const info = vi.fn();
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return init?.method === "POST" ? new Response(JSON.stringify({ status: "pending" }), { status: 201 }) : new Response("{}", { status: 401 });
    }) as typeof fetch;
    const links = createServiceLinks({ targets: TARGETS, signer: async () => s.signer, log: { info, warn: vi.fn() } as never, fetchImpl });
    await expect(links.remoteKnowledge.get("toks5", "k1")).rejects.toMatchObject({ code: "access_requested" });
    await expect(links.remoteKnowledge.get("toks5", "k2")).rejects.toMatchObject({ code: "access_requested" });
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ url: "https://toks5.example.org/api/v1/public/agent/service-enrollments", method: "POST" }]);
    const asked = info.mock.calls.filter(([fields]) => (fields as { event?: string }).event === "service_link.asked");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.[0]).toMatchObject({ alias: "toks5", scope: "knowledge:read", httpStatus: 201 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("jwt-from-signer");
  });
});
