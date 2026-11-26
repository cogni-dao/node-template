// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/org-connect`
 * Purpose: The org's outbound connect talks only to a node the fleet directory lists, with the DIRECTORY's node id as the audience. Each test names a way a signed connect could go to
 *   the wrong place: an origin outside the directory, a node whose own discovery document claims another id, and an oversized answer; and a response body cap in the shared reader.
 * Scope: Pure over a stub tag, signer and fetch. No network, no database.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { connectOrgOutbound, directoryEntry, type OrgDirectoryEntry } from "../src/org-connect";
import { readTextCapped } from "../src/service-auth";

const DIRECTORY: OrgDirectoryEntry[] = [{ origin: "https://node.example.com", nodeId: "node-1" }];

const harness = (agentJson: unknown, answer: unknown = { status: "connected", reason: null }) => {
  const calls: string[] = [];
  const audiences: string[] = [];
  const written: unknown[][] = [];
  const sql = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    written.push(values);
    return [];
  }) as never;
  const signer = { authorizationHeader: async (request: { audienceNodeId: string }) => (audiences.push(request.audienceNodeId), "Bearer x") };
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/.well-known/agent.json")) return new Response(JSON.stringify(agentJson), { status: 200 });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  return { calls, audiences, written, deps: { sql, directory: DIRECTORY, signer: async () => signer, fetch: fetchImpl, version: 1_790_000_000 } };
};

describe("directoryEntry", () => {
  it("finds only a listed canonical origin (a trailing slash is the same origin), never a lookalike", () => {
    expect(directoryEntry(DIRECTORY, "https://node.example.com/")?.nodeId).toBe("node-1");
    expect(directoryEntry(DIRECTORY, "https://node.example.com.evil.test")).toBeNull();
    expect(directoryEntry(DIRECTORY, "http://node.example.com")).toBeNull();
    expect(directoryEntry(DIRECTORY, "https://169.254.169.254")).toBeNull();
  });
});

describe("connectOrgOutbound", () => {
  it("refuses an origin outside the directory before any request is made", async () => {
    const h = harness({ nodeId: "node-1" });
    await expect(connectOrgOutbound(h.deps, "https://other.example.com", "admin-1")).rejects.toMatchObject({ code: "not_in_directory" });
    expect(h.calls).toEqual([]);
  });

  it("refuses when the target's own discovery document names another node id, and sends no signed call", async () => {
    const h = harness({ nodeId: "someone-else" });
    await expect(connectOrgOutbound(h.deps, "https://node.example.com", "admin-1")).rejects.toMatchObject({ code: "wrong_node" });
    expect(h.calls).toEqual(["https://node.example.com/.well-known/agent.json"]);
    expect(h.audiences).toEqual([]);
  });

  it("signs for the DIRECTORY's node id and posts the connect to the listed origin", async () => {
    const h = harness({ nodeId: "node-1" });
    expect(await connectOrgOutbound(h.deps, "https://node.example.com", "admin-1")).toMatchObject({ origin: "https://node.example.com", status: "connected" });
    expect(h.audiences).toEqual(["node-1"]);
    expect(h.calls[1]).toBe("https://node.example.com/api/v1/public/orgs/connect");
  });

  it("sends nothing and signs nothing when this build has no build time (it signs no statement, so it connects to no node)", async () => {
    const h = harness({ nodeId: "node-1" });
    await expect(connectOrgOutbound({ ...h.deps, version: undefined }, "https://node.example.com", "admin-1")).rejects.toMatchObject({ code: "unversioned" });
    expect(h.calls).toEqual([]);
    expect(h.audiences).toEqual([]);
  });

  it("records an acknowledged version only when the target says it APPLIED the statement and holds a version at least ours", async () => {
    const acked = async (answer: Record<string, unknown>) => {
      const h = harness({ nodeId: "node-1" }, { status: "connected", reason: null, ...answer });
      await connectOrgOutbound(h.deps, "https://node.example.com", "admin-1");
      return (h.written.find((values) => values.includes("admin-1")) as unknown[]).includes(1_790_000_000);
    };
    expect(await acked({ applied: true, version: 1_790_000_000 })).toBe(true);
    expect(await acked({ applied: true, version: 1_800_000_000 })).toBe(true);
    // The target kept an older statement (not applied), or holds a lower version, or says nothing: no acknowledgement.
    expect(await acked({ applied: false, version: 1_800_000_000 })).toBe(false);
    expect(await acked({ applied: true, version: 1_700_000_000 })).toBe(false);
    expect(await acked({})).toBe(false);
  });

  it("records the acting admin on the connection row, and keeps only the first 500 characters of the target's reason", async () => {
    const h = harness({ nodeId: "node-1" }, { status: "suspended", reason: "x".repeat(2000) });
    await connectOrgOutbound(h.deps, "https://node.example.com", "admin-1");
    const row = h.written.find((values) => values.includes("admin-1")) as unknown[];
    expect(row).toBeDefined();
    expect((row.find((v) => typeof v === "string" && v.startsWith("xxx")) as string).length).toBe(500);
  });
});

describe("readTextCapped", () => {
  it("refuses a body that crosses the cap while streaming, before buffering it all", async () => {
    const big = new Response("x".repeat(2000));
    await expect(readTextCapped(big, 1000)).rejects.toThrow("too large");
    expect(await readTextCapped(new Response("ok"), 1000)).toBe("ok");
  });
});
