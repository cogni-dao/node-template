// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The GitHub comment verifier (injected fetch, no network), the proof HTTP mapping and the keys row of the admin table (task.0091).
 * The store behavior is in the conformance suite (`credentials.test.ts`, and real SQL in the node).
 */

import { describe, expect, it } from "vitest";
import {
  bindGithubOperation,
  createGithubCommentVerifier,
  credentialHttp,
  evaluateProofComment,
  githubCommentUrl,
  parseIssueAllowlist,
  parseIssueRef,
  proofChallengeOperation,
  proofLine,
} from "../src/credentials";
import { AGENT_KEYS_VIEW, buildNodeAiView } from "../src";

const issue = parseIssueRef("cogni-dao/proof-issues#1") as NonNullable<ReturnType<typeof parseIssueRef>>;
const commentJson = {
  node_id: "IC_node",
  issue_url: "https://api.github.com/repos/cogni-dao/proof-issues/issues/1",
  user: { id: 295942454, login: "agent", type: "User" },
  body: "x",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
};
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

function verifier(handler: (url: string, init: RequestInit) => Response | Promise<Response>, token: string | null = null, requireToken = false) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const v = createGithubCommentVerifier({
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as unknown as typeof fetch,
    getToken: async () => token,
    requireToken,
  });
  return { v, calls };
}

describe("the GitHub comment verifier", () => {
  it("builds its one URL from the allowlist and a number, never follows a redirect, and reads unauthenticated without a token", async () => {
    const { v, calls } = verifier(() => reply(200, commentJson));
    const read = await v.fetchComment({ issue, commentId: 123 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/cogni-dao/proof-issues/issues/comments/123");
    expect(githubCommentUrl(issue, 123)).toBe(calls[0]?.url);
    expect(calls[0]?.init.redirect).toBe("error");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(read).toMatchObject({ kind: "found", comment: { userId: 295942454, login: "agent", userType: "User", issueUrl: commentJson.issue_url } });
    if (read.kind === "found") expect(read.comment.lastEditedAt).toBeUndefined(); // not read without a token
  });

  it("with a token it also reads GraphQL lastEditedAt, so an edit in the same second is seen", async () => {
    const { v, calls } = verifier((url) => (url.endsWith("/graphql") ? reply(200, { data: { node: { lastEditedAt: "2026-11-11T10:00:00Z" } } }) : reply(200, commentJson)), "tok");
    const read = await v.fetchComment({ issue, commentId: 7 });
    expect(read).toMatchObject({ kind: "found", comment: { lastEditedAt: "2026-11-11T10:00:00Z" } });
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[1]?.init.body)).variables).toEqual({ id: "IC_node" });
    const clean = verifier((url) => (url.endsWith("/graphql") ? reply(200, { data: { node: { lastEditedAt: null } } }) : reply(200, commentJson)), "tok");
    expect(await clean.v.fetchComment({ issue, commentId: 7 })).toMatchObject({ kind: "found", comment: { lastEditedAt: null } });
  });

  it("a failed or odd GraphQL answer with a token is unavailable (fail closed), a deleted comment is not_found", async () => {
    for (const gql of [reply(500, {}), reply(200, { errors: [{ message: "x" }] }), reply(200, { data: { node: {} } }), reply(200, "not json")]) {
      const { v } = verifier((url) => (url.endsWith("/graphql") ? gql.clone() : reply(200, commentJson)), "tok");
      expect(await v.fetchComment({ issue, commentId: 7 })).toEqual({ kind: "unavailable" });
    }
    const gone = verifier((url) => (url.endsWith("/graphql") ? reply(200, { data: { node: null } }) : reply(200, commentJson)), "tok");
    expect(await gone.v.fetchComment({ issue, commentId: 7 })).toEqual({ kind: "not_found" });
  });

  it("404 is not_found; 403, 429, 5xx, a thrown fetch, bad JSON and an oversized body are unavailable", async () => {
    expect(await verifier(() => reply(404, {})).v.fetchComment({ issue, commentId: 1 })).toEqual({ kind: "not_found" });
    for (const status of [403, 429, 500, 503]) expect(await verifier(() => reply(status, {})).v.fetchComment({ issue, commentId: 1 })).toEqual({ kind: "unavailable" });
    expect(
      await verifier(() => {
        throw new Error("timeout");
      }).v.fetchComment({ issue, commentId: 1 })
    ).toEqual({ kind: "unavailable" });
    expect(await verifier(() => reply(200, "{oops")).v.fetchComment({ issue, commentId: 1 })).toEqual({ kind: "unavailable" });
    expect(await verifier(() => reply(200, commentJson, { "content-length": String(300 * 1024) })).v.fetchComment({ issue, commentId: 1 })).toEqual({
      kind: "unavailable",
    });
    expect(await verifier(() => reply(200, JSON.stringify({ ...commentJson, body: "y".repeat(300 * 1024) }))).v.fetchComment({ issue, commentId: 1 })).toEqual({
      kind: "unavailable",
    });
  });

  it("production fails closed: no token with requireToken is unavailable and nothing is fetched; a bad comment id never fetches", async () => {
    const { v, calls } = verifier(() => reply(200, commentJson), null, true);
    expect(await v.fetchComment({ issue, commentId: 1 })).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
    const open = verifier(() => reply(200, commentJson));
    for (const id of [0, -1, 1.5, Number.NaN]) expect(await open.v.fetchComment({ issue, commentId: id })).toEqual({ kind: "not_found" });
    expect(open.calls).toHaveLength(0);
    const thrown = createGithubCommentVerifier({
      fetch: (async () => reply(200, commentJson)) as unknown as typeof fetch,
      getToken: async () => {
        throw new Error("app down");
      },
    });
    expect(await thrown.fetchComment({ issue, commentId: 1 })).toEqual({ kind: "unavailable" });
  });

  it("the allowlist keeps only owner/repo#number entries", () => {
    expect(parseIssueAllowlist("cogni-dao/node-template#12, bad entry ../x#1  a/b#0 o/r#3")).toEqual(["cogni-dao/node-template#12", "o/r#3"]);
    expect(parseIssueAllowlist(undefined)).toEqual([]);
  });

  it("the allowlist drops an entry with an upper case letter (GitHub's issue_url is lowercase)", () => {
    expect(parseIssueAllowlist("Cogni-DAO/node-template#12,cogni-dao/Node-Template#13,cogni-dao/node-template#14")).toEqual(["cogni-dao/node-template#14"]);
  });
});

describe("the proof HTTP mapping", () => {
  it("bind: 201 when created, 200 when already bound; the body parses through its contract", () => {
    const created = credentialHttp({ op: "bind", result: { ok: true, result: "created", githubId: "1", userType: "User" } });
    expect(created.status).toBe(201);
    expect(bindGithubOperation.output.parse(created.body)).toMatchObject({ bound: true, githubId: "1" });
    expect(credentialHttp({ op: "bind", result: { ok: true, result: "already_bound", githubId: "1", userType: "Bot" } }).status).toBe(200);
  });

  it("a failed comment is 422 with a fixed reason; a wrong challenge is one 401; unavailable is 503 with retry-after; limits are 429", () => {
    const failed = credentialHttp({ op: "bind", result: { ok: false, reason: "proof_failed", failure: "comment_edited" } });
    expect(failed).toMatchObject({ status: 422, body: { error: "proof_failed", reason: "comment_edited" }, refusal: "proof_failed", reason: "comment_edited" });
    expect(credentialHttp({ op: "recover", result: { ok: false, reason: "invalid_challenge" } })).toMatchObject({ status: 401, body: { error: "invalid_challenge" } });
    expect(credentialHttp({ op: "recover", result: { ok: false, reason: "proof_unavailable" } })).toMatchObject({ status: 503, headers: { "retry-after": "30" } });
    expect(credentialHttp({ op: "recover", result: { ok: false, reason: "recovery_limited" } }).status).toBe(429);
    expect(credentialHttp({ op: "challenge", result: { ok: false, reason: "rate_limited" } })).toMatchObject({ status: 429, headers: { "retry-after": "60" } });
    expect(credentialHttp({ op: "recover", result: { ok: false, reason: "no_binding" } }).status).toBe(404);
    expect(credentialHttp({ op: "bind", result: { ok: false, reason: "already_linked" } }).status).toBe(409);
    expect(credentialHttp({ op: "bind", result: { ok: false, reason: "binding_exists" } }).status).toBe(409);
    expect(credentialHttp({ op: "recover", result: { ok: false, reason: "stopped" } }).status).toBe(403);
    expect(credentialHttp({ op: "upgrade", result: { ok: false, reason: "stopped" } })).toMatchObject({ status: 403, body: { error: "stopped" } });
    expect(credentialHttp({ op: "confirm", credentialId: "c", result: { ok: false, reason: "stopped" } })).toMatchObject({ status: 409, body: { error: "superseded" } });
  });

  it("stop and lift: 200 bodies, and the admin gate maps to 403 and 503", () => {
    expect(credentialHttp({ op: "stop", result: { ok: true, revokedCount: 2 } })).toMatchObject({ status: 200, body: { revoked: 2 } });
    expect(credentialHttp({ op: "lift", result: { ok: true } })).toMatchObject({ status: 200, body: { lifted: true } });
    expect(credentialHttp({ op: "stop", result: { ok: false, reason: "authz_denied" } }).status).toBe(403);
    expect(credentialHttp({ op: "lift", result: { ok: false, reason: "authz_unavailable" } }).status).toBe(503);
    expect(credentialHttp({ op: "lift", result: { ok: false, reason: "self_lift" } }).status).toBe(403);
    expect(credentialHttp({ op: "lift", result: { ok: false, reason: "not_stopped" } }).status).toBe(409);
    expect(credentialHttp({ op: "stop", result: { ok: false, reason: "principal_not_found" } }).status).toBe(404);
  });

  it("the challenge body carries the secret once and never a hash; every answer is no-store", () => {
    const res = credentialHttp({
      op: "challenge",
      result: { ok: true, challengeId: crypto.randomUUID(), proofLine: "cogni-proof:v1:n:c:x", challengeSecret: "s".repeat(43), expiresAt: "2026-11-11T10:10:00Z", issues: ["o/r#1"] },
    });
    expect(Object.keys(proofChallengeOperation.output.parse(res.body)).sort()).toEqual(["challengeId", "challengeSecret", "expiresAt", "issues", "proofLine"]);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(credentialHttp({ op: "bind", result: { ok: false, reason: "proof_failed", failure: "line_missing" } }).headers["cache-control"]).toBe("no-store");
  });
});

describe("the keys row of the admin table", () => {
  const view = (keyHolders: Parameters<typeof buildNodeAiView>[0]["keyHolders"]) =>
    buildNodeAiView({ declarations: {}, scopesByPrincipal: {}, internal: [], rows: [], keyHolders });

  it("one row per key holder: Off for a stopped agent, On otherwise, the proven GitHub id as the hint, and plain copy", () => {
    const rows = view([
      { userId: "u1", name: "Flock", githubId: "295942454", on: true },
      { userId: "u2", name: null, githubId: null, on: false },
    ]);
    expect(rows).toMatchObject([
      { principalUserId: "u1", who: "Flock", hint: "GitHub id 295942454", scope: "agent:keys", on: true, section: "outside", outside: true },
      { principalUserId: "u2", who: "Unnamed agent", hint: null, scope: "agent:keys", on: false },
    ]);
    expect(rows[0]?.label).toBe(AGENT_KEYS_VIEW.label);
    expect(`${AGENT_KEYS_VIEW.label} ${AGENT_KEYS_VIEW.description}`).not.toMatch(/:|\/api\/|token|curl|\bjobs?\b/i);
  });

  it("agent:keys is not a declared scope: it is never read from the declarations, so an undeclared scope cannot grow a keys row", () => {
    expect(view(undefined)).toEqual([]);
    expect(buildNodeAiView({ declarations: { "agent:keys": { label: "x", description: "y" } }, scopesByPrincipal: {}, internal: [], rows: [] })).toEqual([]);
  });

  it("evaluateProofComment compares the issue URL case-insensitively and still answers wrong_issue for another issue (task.0095)", async () => {
    const nonce = "n".repeat(22);
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const expect_ = { nodeId: "node-1", challengeId: "11111111-1111-4111-8111-111111111111", nonceHash: hex, issuedAt: "2026-11-11T09:59:00Z", expiresAt: "2026-11-11T10:30:00Z", commentSkewSec: 60 };
    const comment = (issueUrl: string) => ({
      kind: "found" as const,
      comment: {
        issueUrl,
        userId: 295942454,
        login: "agent",
        userType: "User",
        body: proofLine("node-1", expect_.challengeId, nonce),
        createdAt: "2026-11-11T10:00:00Z",
        updatedAt: "2026-11-11T10:00:00Z",
        lastEditedAt: null,
      },
    });
    expect(await evaluateProofComment(comment("https://api.github.com/repos/Cogni-DAO/Proof-Issues/issues/1"), issue, expect_)).toMatchObject({ ok: true });
    expect(await evaluateProofComment(comment("https://api.github.com/repos/cogni-dao/proof-issues/issues/2"), issue, expect_)).toEqual({ ok: false, reason: "wrong_issue" });
  });
});
