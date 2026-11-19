// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CORE_TOOL_BUNDLE, withoutRemoteNodeArgument } from "../src/catalog";
import { createKnowledgeReadImplementation } from "../src/tools/knowledge-read";
import { createKnowledgeSearchImplementation } from "../src/tools/knowledge-search";
import {
  createRemoteKnowledgeTransport,
  ACCESS_REQUESTED_MESSAGE,
  REMOTE_ASK_INTERVAL_MS,
  REMOTE_ENTRY_CONTENT_MAX_CHARS,
  REMOTE_MAX_BODY_BYTES,
  RemoteKnowledgeError,
  redactSecretShapes,
} from "../src/remote-knowledge";

const TARGET = { alias: "toks5", nodeId: "node-toks5", origin: "https://toks5.example.org" };
const row = (over: Record<string, unknown> = {}) => ({
  id: "k1",
  domain: "meta",
  entityId: null,
  title: "Poly facts",
  content: "the content",
  entryType: "fact",
  confidencePct: 80,
  sourceType: "human",
  sourceRef: null,
  tags: null,
  evaluateAt: null,
  resolutionStrategy: null,
  createdAt: null,
  ...over,
});
const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "set-cookie": "secret=1" }, ...init });

const harness = (respond: (url: string, init: RequestInit) => Response | Promise<Response>, over: Record<string, unknown> = {}) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as unknown as typeof fetch;
  const authorize = vi.fn(async () => "Bearer signed-assertion");
  const remote = createRemoteKnowledgeTransport({ targets: [TARGET], authorize, fetchImpl, ...over });
  return { remote, calls, authorize, fetchImpl };
};

describe("remote knowledge transport", () => {
  it("an unknown alias fails before any signing or network call", async () => {
    const h = harness(() => jsonResponse(row()));
    await expect(h.remote.get("nope", "k1")).rejects.toMatchObject({ code: "unknown_alias" });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.remote.originOf("nope")).toBeUndefined();
    expect(h.remote.originOf("toks5")).toBe(TARGET.origin);
  });

  it("sends one GET to the configured origin with a signed header, redirects off and a timeout signal", async () => {
    const h = harness(() => jsonResponse(row()));
    await h.remote.get("toks5", "k1.v2-a_b");
    const [call] = h.calls;
    expect(call?.url).toBe("https://toks5.example.org/api/v1/knowledge/k1.v2-a_b");
    expect(call?.init.method).toBe("GET");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer signed-assertion");
    expect(call?.init.body).toBeUndefined();
    expect(h.authorize).toHaveBeenCalledWith(TARGET, "knowledge:read");
  });

  it("an id that is not a knowledge id is refused before any URL is built or any assertion is signed", async () => {
    const h = harness(() => jsonResponse(row()));
    const bad = ["", ".", "..", "../admin", "..%2fadmin", "a/b", "a\\b", "-start", ".hidden", "a?b=1", "a#frag", "a b", "a\nb", "é", "a".repeat(257), "https://evil.example/x"];
    for (const id of bad) {
      await expect(h.remote.get("toks5", id), JSON.stringify(id)).rejects.toMatchObject({ code: "invalid_id", message: "Invalid knowledge id" });
    }
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    // The longest allowed id, and ids with dots inside, pass.
    await h.remote.get("toks5", `a${"b".repeat(255)}`);
    await h.remote.get("toks5", "v1.2..3");
    expect(h.calls).toHaveLength(2);
  });

  it("list and search use only the list path on the configured origin", async () => {
    const h = harness(() => jsonResponse({ items: [row(), row({ id: "k2", title: "Other", content: "nothing" })], domains: ["meta"] }));
    const listed = await h.remote.list("toks5", { domain: "meta", limit: 5 });
    expect(listed.map((r) => r.id)).toEqual(["k1", "k2"]);
    const found = await h.remote.search("toks5", { domain: "meta", query: "POLY", limit: 5 });
    expect(found.map((r) => r.id)).toEqual(["k1"]);
    const urls = h.calls.map((c) => new URL(c.url));
    expect(urls.every((u) => u.origin === TARGET.origin && u.pathname === "/api/v1/knowledge")).toBe(true);
    expect(urls[1]?.searchParams.get("q")).toBe("POLY");
    expect(h.calls.every((c) => c.init.method === "GET")).toBe(true);
  });

  it("a 401 or 403 is a fixed non-retryable policy_denied and carries nothing from the target", async () => {
    for (const status of [401, 403]) {
      const h = harness(() => new Response(JSON.stringify({ error: "grant for cogni_ag_sk_leak is off" }), { status }));
      const error = await h.remote.get("toks5", "k1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemoteKnowledgeError);
      expect(error).toMatchObject({ code: "policy_denied", message: "Tool call denied by policy" });
      expect((error as RemoteKnowledgeError).receipt).toEqual({ code: "policy_denied", retryable: false, lookup: { tool: "remote_knowledge", node: "toks5" } });
      expect(JSON.stringify(error)).not.toContain("leak");
    }
  });

  it("a 404 is an absent entry; a 5xx, a redirect and a network failure are retryable unavailable (no receipt), never followed", async () => {
    expect(await harness(() => new Response("{}", { status: 404 })).remote.get("toks5", "k1")).toBeNull();
    for (const response of [
      () => new Response("{}", { status: 503 }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example.org/" } }),
      () => {
        throw new TypeError("network");
      },
    ]) {
      const h = harness(response);
      const error = await h.remote.get("toks5", "k1").catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "unavailable", message: "Remote knowledge is unavailable" });
      expect((error as RemoteKnowledgeError).receipt).toBeUndefined();
      expect(h.calls).toHaveLength(1);
    }
  });

  it("a request that does not answer within the timeout is unavailable", async () => {
    const h = harness(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
        }),
      { timeoutMs: 25 }
    );
    const error = await h.remote.get("toks5", "k1").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unavailable" });
    // A timeout is retryable: no terminal receipt.
    expect((error as RemoteKnowledgeError).receipt).toBeUndefined();
  });

  it("cuts each entry's content to 64 KiB before it reaches the model (get, list and search)", async () => {
    const long = "x".repeat(REMOTE_ENTRY_CONTENT_MAX_CHARS + 500);
    const h = harness((url) => (url.includes("?") ? jsonResponse({ items: [row({ content: long })], domains: [] }) : jsonResponse(row({ content: long }))));
    const got = await h.remote.get("toks5", "k1");
    expect(got?.content.length).toBe(REMOTE_ENTRY_CONTENT_MAX_CHARS + 1);
    expect(got?.content.endsWith("…")).toBe(true);
    expect((await h.remote.list("toks5", { domain: "meta", limit: 5 }))[0]?.content.length).toBe(REMOTE_ENTRY_CONTENT_MAX_CHARS + 1);
    expect((await h.remote.search("toks5", { domain: "meta", query: "xxx", limit: 5 }))[0]?.content.length).toBe(REMOTE_ENTRY_CONTENT_MAX_CHARS + 1);
    const short = await harness(() => jsonResponse(row({ content: "short" }))).remote.get("toks5", "k1");
    expect(short?.content).toBe("short");
  });

  it("a body over the cap is refused while it streams, whatever content-length says", async () => {
    const big = "x".repeat(REMOTE_MAX_BODY_BYTES + 1);
    const h = harness(() => new Response(JSON.stringify(row({ content: big }))));
    await expect(h.remote.get("toks5", "k1")).rejects.toMatchObject({ code: "unavailable" });
    const declared = harness(() => new Response("{}", { headers: { "content-length": String(REMOTE_MAX_BODY_BYTES + 1) } }));
    await expect(declared.remote.get("toks5", "k1")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("redacts agent keys and JWT-shaped strings from a body, and returns no response header", async () => {
    const jwt = "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJodHRwczovL3gifQ.c2lnbmF0dXJl";
    const h = harness(() => jsonResponse(row({ content: `key cogni_ag_sk_AbC123-xyz_9 and token ${jwt} end`, title: "cogni_ag_sk_zzzzzzzz" })));
    const entry = await h.remote.get("toks5", "k1");
    expect(entry?.content).toBe("key [REDACTED] and token [REDACTED] end");
    expect(entry?.title).toBe("[REDACTED]");
    expect(JSON.stringify(entry)).not.toContain("set-cookie");
    expect(Object.keys(entry ?? {}).sort()).toEqual(Object.keys(row()).sort());
    expect(redactSecretShapes("plain text")).toBe("plain text");
  });
});

describe("remote knowledge index (the routing projection)", () => {
  const indexRow = (over: Record<string, unknown> = {}) => ({ id: "k1", domain: "meta", entryType: "fact", useWhen: "when reading about poly", ...over });

  it("sends one signed GET to /api/v1/knowledge/index on the configured origin with domain, q and limit, and returns id, domain, entryType and trigger only", async () => {
    const h = harness(() => jsonResponse({ items: [indexRow(), indexRow({ id: "k2", useWhen: null }), { id: "bad" }], domains: ["meta"], total: 3 }));
    const rows = await h.remote.index("toks5", { domain: "meta", q: "poly", limit: 10 });
    expect(rows).toEqual([indexRow(), indexRow({ id: "k2", useWhen: null })]);
    expect(h.calls).toHaveLength(1);
    const url = new URL(h.calls[0]?.url as string);
    expect(url.origin).toBe(TARGET.origin);
    expect(url.pathname).toBe("/api/v1/knowledge/index");
    expect(Object.fromEntries(url.searchParams)).toEqual({ domain: "meta", q: "poly", limit: "10" });
    expect(h.calls[0]?.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect((h.calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer signed-assertion");
  });

  it("omits an unset domain and q, bounds the limit to 1000, caps rows at limit, and never carries content through", async () => {
    const h = harness(() => jsonResponse({ items: [indexRow({ content: "body that must not pass" }), indexRow({ id: "k2" }), indexRow({ id: "k3" })] }));
    const rows = await h.remote.index("toks5", { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty("content");
    expect([...new URL(h.calls[0]?.url as string).searchParams.keys()]).toEqual(["limit"]);
    await h.remote.index("toks5", { limit: 50_000 });
    expect(new URL(h.calls[1]?.url as string).searchParams.get("limit")).toBe("1000");
  });

  it("an unknown alias fails before any signing or network call", async () => {
    const h = harness(() => jsonResponse({ items: [] }));
    await expect(h.remote.index("nope", { limit: 5 })).rejects.toMatchObject({ code: "unknown_alias" });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the same caps, redaction and denial behaviour: a 403 is policy_denied, a 5xx is unavailable, a secret shape is redacted, an oversized body is refused", async () => {
    await expect(harness(() => new Response("", { status: 403 })).remote.index("toks5", { limit: 5 })).rejects.toMatchObject({ code: "policy_denied" });
    await expect(harness(() => new Response("", { status: 503 })).remote.index("toks5", { limit: 5 })).rejects.toMatchObject({ code: "unavailable" });
    const leaked = harness(() => jsonResponse({ items: [indexRow({ useWhen: "when cogni_ag_sk_v1_abcDEF123 shows" })] }));
    expect((await leaked.remote.index("toks5", { limit: 5 }))[0]?.useWhen).toBe("when [REDACTED] shows");
    const big = harness(() => new Response("x".repeat(REMOTE_MAX_BODY_BYTES + 1), { status: 200 }));
    await expect(big.remote.index("toks5", { limit: 5 })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("a 401 to a signed index read sends ONE ask and the read is access_requested", async () => {
    const calls: string[] = [];
    const h = harness((url) => {
      calls.push(url);
      return url.endsWith("/service-enrollments") ? jsonResponse({ status: "pending" }, { status: 201 }) : new Response("", { status: 401 });
    });
    await expect(h.remote.index("toks5", { limit: 5 })).rejects.toMatchObject({ code: "access_requested" });
    expect(calls.filter((u) => u.endsWith("/api/v1/public/agent/service-enrollments"))).toHaveLength(1);
  });
});

describe("the stock knowledge tools with a `node` argument", () => {
  const local = {
    get: vi.fn(async () => row({ id: "local" })),
    list: vi.fn(async () => []),
    search: vi.fn(async () => [row({ id: "local" })]),
  };
  const setup = () => {
    const h = harness((url) => (url.includes("?") ? jsonResponse({ items: [row()], domains: [] }) : jsonResponse(row())));
    const deps = { knowledgeCapability: local as never, nodePublicOrigin: "https://local.example.org", remoteKnowledge: h.remote };
    return { h, read: createKnowledgeReadImplementation(deps), search: createKnowledgeSearchImplementation(deps) };
  };

  it("reads and searches the named node, with provenance from that node's origin, and leaves the local store alone", async () => {
    const { read, search } = setup();
    const got = await read.execute({ id: "k1", node: "toks5" }, undefined as never);
    expect(got.entries[0]).toMatchObject({ id: "k1", sourceUrl: "https://toks5.example.org/knowledge/k1" });
    const listed = await read.execute({ domain: "meta", node: "toks5" }, undefined as never);
    expect(listed.mode).toBe("list");
    const found = await search.execute({ domain: "meta", query: "poly", node: "toks5" }, undefined as never);
    expect(found.results[0]).toMatchObject({ id: "k1", sourceUrl: "https://toks5.example.org/knowledge/k1" });
    expect(local.get).not.toHaveBeenCalled();
    expect(local.search).not.toHaveBeenCalled();
  });

  it("without a node the local store answers, exactly as before", async () => {
    const { read, search } = setup();
    expect((await read.execute({ id: "local" }, undefined as never)).entries[0]).toMatchObject({ id: "local", sourceUrl: "https://local.example.org/knowledge/local" });
    expect((await search.execute({ domain: "meta", query: "x" }, undefined as never)).results[0]?.id).toBe("local");
  });

  it("an alias the server does not list, or no remote capability at all, is refused with a fixed message", async () => {
    const { read, search } = setup();
    await expect(read.execute({ id: "k1", node: "nope" }, undefined as never)).rejects.toThrow("Unknown node alias");
    await expect(search.execute({ domain: "meta", query: "x", node: "nope" }, undefined as never)).rejects.toThrow("Unknown node alias");
    const bare = createKnowledgeReadImplementation({ knowledgeCapability: local as never });
    await expect(bare.execute({ id: "k1", node: "toks5" }, undefined as never)).rejects.toThrow("Unknown node alias");
  });
});

describe("the `node` argument is advertised only when the node has link targets", () => {
  const find = (bundle: ReturnType<typeof withoutRemoteNodeArgument>, name: string) => bundle.find((t) => t.contract.name === name);
  const props = (tool: ReturnType<typeof find>) => Object.keys((z.toJSONSchema(tool?.contract.inputSchema as never) as { properties: Record<string, unknown> }).properties);

  it("the stock bundle advertises `node`; the local bundle leaves it out of both tools' schema and description and keeps every other tool", () => {
    const local = withoutRemoteNodeArgument(CORE_TOOL_BUNDLE);
    for (const name of ["core__knowledge_read", "core__knowledge_search"]) {
      expect(props(find(CORE_TOOL_BUNDLE, name)), name).toContain("node");
      expect(find(CORE_TOOL_BUNDLE, name)?.contract.description).toContain("'node'");
      expect(props(find(local, name)), name).not.toContain("node");
      expect(find(local, name)?.contract.description).not.toContain("'node'");
      expect(find(local, name)?.contract.name).toBe(name);
    }
    expect(local.map((t) => t.contract.name)).toEqual(CORE_TOOL_BUNDLE.map((t) => t.contract.name));
    const others = local.filter((t) => !t.contract.name.startsWith("core__knowledge_re") && t.contract.name !== "core__knowledge_search");
    expect(others.every((t, i) => t === CORE_TOOL_BUNDLE.filter((x) => others.some((o) => o.contract.name === x.contract.name))[i])).toBe(true);
  });

  it("a local-only tool refuses a call that carries `node` (a validation error), and still accepts the same call without it", () => {
    for (const [name, ok] of [
      ["core__knowledge_read", { id: "k1" }],
      ["core__knowledge_search", { domain: "meta", query: "x" }],
    ] as const) {
      const schema = find(withoutRemoteNodeArgument(CORE_TOOL_BUNDLE), name)?.contract.inputSchema as z.ZodType;
      expect(schema.safeParse(ok).success, name).toBe(true);
      expect(schema.safeParse({ ...ok, node: "toks5" }).success, name).toBe(false);
      expect(schema.safeParse({ ...ok, anything: 1 }).success, name).toBe(false);
      // The stock tool still takes `node`.
      expect((find(CORE_TOOL_BUNDLE, name)?.contract.inputSchema as z.ZodType).safeParse({ ...ok, node: "toks5" }).success, name).toBe(true);
    }
  });
});

describe("a 401 to the node AI's signed read sends ONE access ask", () => {
  const ENROLL = "https://toks5.example.org/api/v1/public/agent/service-enrollments";

  /** GET answers `getStatus`; the enrollment POST answers `askStatus`. */
  const rig = (getStatus: number, askStatus: number | Error = 201) => {
    const clock = { now: 1_000_000 };
    const asks: Array<{ url: string; init: RequestInit }> = [];
    const onAsked = vi.fn();
    const h = harness(
      (url, init) => {
        if (init.method === "POST") {
          asks.push({ url, init });
          if (askStatus instanceof Error) throw askStatus;
          return new Response(JSON.stringify({ status: "pending" }), { status: askStatus });
        }
        return new Response("{}", { status: getStatus });
      },
      { now: () => clock.now, onAsked }
    );
    return { ...h, clock, asks, onAsked };
  };
  const deps = (r: ReturnType<typeof rig>) => ({ knowledgeCapability: {} as never, nodePublicOrigin: "https://local.example.org", remoteKnowledge: r.remote });

  it("401 sends exactly one signed ask for knowledge:read to the enrollment route, then the read is access_requested (fixed message, no receipt)", async () => {
    const r = rig(401);
    const error = await r.remote.get("toks5", "k1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteKnowledgeError);
    expect(error).toMatchObject({ code: "access_requested", message: ACCESS_REQUESTED_MESSAGE });
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]?.url).toBe(ENROLL);
    expect(r.asks[0]?.init).toMatchObject({ method: "POST", redirect: "manual", body: JSON.stringify({ scope: "knowledge:read" }) });
    expect((r.asks[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer signed-assertion");
    // Two signed assertions: one for the read, one for the ask (a fresh one per call).
    expect(r.authorize).toHaveBeenCalledTimes(2);
    expect(r.authorize).toHaveBeenLastCalledWith(TARGET, "knowledge:read");
    expect(r.onAsked).toHaveBeenCalledTimes(1);
    expect(r.onAsked).toHaveBeenCalledWith({ alias: "toks5", scope: "knowledge:read", httpStatus: 201 });
  });

  it("the stock tools return the fixed terminal result { status: access_requested, node, message } with no entries", async () => {
    const r = rig(401);
    const out = await createKnowledgeReadImplementation(deps(r)).execute({ id: "k1", node: "toks5" }, undefined as never);
    expect(out).toEqual({ mode: "get", entries: [], totalFound: 0, status: "access_requested", node: "toks5", message: "Access requested; an admin of that node must turn it On." });
    const found = await createKnowledgeSearchImplementation(deps(r)).execute({ domain: "meta", query: "x", node: "toks5" }, undefined as never);
    expect(found).toEqual({ query: "x", domain: "meta", results: [], totalFound: 0, status: "access_requested", node: "toks5", message: ACCESS_REQUESTED_MESSAGE });
    // Both calls were answered from one ask.
    expect(r.asks).toHaveLength(1);
  });

  it("a second 401 within 10 minutes sends no second ask and answers the same; after 10 minutes it asks again", async () => {
    const r = rig(401);
    await r.remote.get("toks5", "k1").catch(() => undefined);
    r.clock.now += REMOTE_ASK_INTERVAL_MS - 1;
    await expect(r.remote.get("toks5", "k2")).rejects.toMatchObject({ code: "access_requested" });
    await expect(r.remote.list("toks5", { domain: "meta", limit: 5 })).rejects.toMatchObject({ code: "access_requested" });
    expect(r.asks).toHaveLength(1);
    r.clock.now += 1;
    await expect(r.remote.get("toks5", "k3")).rejects.toMatchObject({ code: "access_requested" });
    expect(r.asks).toHaveLength(2);
  });

  it("concurrent 401s send one ask", async () => {
    const r = rig(401);
    const results = await Promise.allSettled([r.remote.get("toks5", "a"), r.remote.get("toks5", "b"), r.remote.get("toks5", "c")]);
    expect(results.every((x) => x.status === "rejected")).toBe(true);
    expect(r.asks).toHaveLength(1);
  });

  it("a 403 stays policy_denied and never asks", async () => {
    const r = rig(403);
    const error = await r.remote.get("toks5", "k1").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "policy_denied", message: "Tool call denied by policy" });
    expect((error as RemoteKnowledgeError).receipt).toMatchObject({ retryable: false });
    expect(r.asks).toHaveLength(0);
    expect(r.onAsked).not.toHaveBeenCalled();
  });

  it("an ask the target refuses or cannot receive is policy_denied, not access_requested, and is not retried inside the interval", async () => {
    for (const askStatus of [401, 503, new TypeError("net")]) {
      const r = rig(401, askStatus);
      await expect(r.remote.get("toks5", "k1"), String(askStatus)).rejects.toMatchObject({ code: "policy_denied" });
      await expect(r.remote.get("toks5", "k1"), String(askStatus)).rejects.toMatchObject({ code: "policy_denied" });
      expect(r.asks).toHaveLength(1);
      r.clock.now += REMOTE_ASK_INTERVAL_MS;
      await r.remote.get("toks5", "k1").catch(() => undefined);
      expect(r.asks).toHaveLength(2);
    }
  });

  it("other statuses never ask: a 404, a 5xx and a success", async () => {
    for (const status of [404, 500]) {
      const r = rig(status);
      await r.remote.get("toks5", "k1").catch(() => undefined);
      expect(r.asks).toHaveLength(0);
    }
  });
});
