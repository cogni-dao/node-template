// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CORE_TOOL_BUNDLE, withoutRemoteNodeArgument } from "../src/catalog";
import { createKnowledgeReadImplementation } from "../src/tools/knowledge-read";
import { createKnowledgeSearchImplementation } from "../src/tools/knowledge-search";
import {
  createRemoteKnowledgeTransport,
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
