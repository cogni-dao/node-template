// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` proofs
 * Purpose: The proof of a GitHub account: the proof line, the challenge secret, the `ProofVerifier` port, the GitHub comment verifier and the
 *   pure check of a comment against a challenge.
 * Scope: No store, no env, no logging. The node injects `fetch` and `getToken`. The verifier builds its one URL from the allowlist and a number.
 * Invariants:
 *   - PROOF_LINE_HOLDS_NO_SECRET: the line `cogni-proof:v1:<node_id>:<challenge_id>:<nonce>` is public. The node id stops a replay on another node.
 *     The requester alone gets `challengeSecret`; the store keeps only sha256 of it and of the nonce.
 *   - NO_CALLER_URL: the fetched URL is `https://api.github.com/repos/{owner}/{repo}/issues/comments/{id}` from an allowlist entry and an integer.
 *     `redirect: "error"`, a 5 second timeout, a 256 KB body cap.
 *   - EDITED_COMMENT_PROVES_NOTHING: `updated_at != created_at` is refused (`comment_edited`). With a token, GraphQL `lastEditedAt` must also be
 *     null (an edit in the same second as the post leaves both times equal).
 *   - UNAVAILABLE_IS_NOT_A_FAILURE: GitHub 403, 429, 5xx, a timeout or a missing token (when required) is `unavailable`. It consumes nothing.
 * Side-effects: network (the verifier only, through the injected `fetch`)
 * Links: https://cognidao.org/work/items/task.5474
 * @public
 */

const GHOST_USER_ID = 10137;
const MAX_BODY_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const PROOF_LINE = /^cogni-proof:v1:([^:\s]+):([0-9a-f-]{36}):([A-Za-z0-9_-]{22,64})$/;

export const proofLine = (nodeId: string, challengeId: string, nonce: string): string => `cogni-proof:v1:${nodeId}:${challengeId}:${nonce}`;

/** The parts of a proof line, or null when the line is not one. The nonce is checked by hash, never compared in the clear against a stored value. */
export function parseProofLine(line: string): { nodeId: string; challengeId: string; nonce: string } | null {
  const m = PROOF_LINE.exec(line);
  return m ? { nodeId: m[1] as string, challengeId: m[2] as string, nonce: m[3] as string } : null;
}

/** An allowlisted proof issue: `owner/repo#number`. */
export interface IssueRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const ISSUE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/;

export function parseIssueRef(text: string): IssueRef | null {
  const m = ISSUE.exec(text);
  return m ? { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) } : null;
}

/**
 * Parse a comma or space separated allowlist. An entry that is not `owner/repo#number`, or that holds an upper case letter, is dropped: GitHub's
 * `issue_url` is lowercase, so a lowercase entry is the one form that always matches (task.0095).
 */
export function parseIssueAllowlist(text: string | undefined): string[] {
  return (text ?? "")
    .split(/[\s,]+/)
    .filter((entry) => entry === entry.toLowerCase() && parseIssueRef(entry) !== null);
}

/** What a comment says, as the verifier read it. */
export interface ProofComment {
  readonly issueUrl: string;
  /** `user.id`, or null when the author is gone (a deleted account). */
  readonly userId: number | null;
  readonly login: string | null;
  readonly userType: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** GraphQL `lastEditedAt`: null = never edited, a string = edited, undefined = not read (no token). */
  readonly lastEditedAt?: string | null | undefined;
}

export type CommentRead =
  | { readonly kind: "found"; readonly comment: ProofComment }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

/** The port: read one comment. The package ships the GitHub verifier; a public-key verifier would fit the same port. */
export interface ProofVerifier {
  fetchComment(input: { issue: IssueRef; commentId: number }): Promise<CommentRead>;
}

export type ProofFailure =
  | "comment_not_found"
  | "issue_not_allowed"
  | "wrong_issue"
  | "author_invalid"
  | "comment_edited"
  | "line_missing"
  | "outside_window";

/** The facts about a challenge that a comment is checked against. */
export interface ProofExpectation {
  readonly nodeId: string;
  readonly challengeId: string;
  readonly nonceHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly commentSkewSec: number;
}

export type ProofEvaluation =
  | { readonly ok: true; readonly githubId: string; readonly login: string; readonly userType: "User" | "Bot" }
  | { readonly ok: false; readonly reason: ProofFailure };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 32 random bytes, base64url (43 chars). */
export const randomSecret = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** A challenge secret has the shape of `randomSecret()`. A different shape is refused before any store read. */
export const isWellFormedChallengeSecret = (secret: unknown): secret is string => typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(secret);

export const githubCommentUrl = (issue: IssueRef, commentId: number): string =>
  `https://api.github.com/repos/${issue.owner}/${issue.repo}/issues/comments/${commentId}`;
const issueApiUrl = (issue: IssueRef): string => `https://api.github.com/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;

/**
 * Check a comment against a challenge. Pure, so the memory store, real SQL and the HTTP verifier all share one decision. Order: found, issue,
 * author, edits, line, time window.
 */
export async function evaluateProofComment(read: CommentRead, issue: IssueRef, expect: ProofExpectation): Promise<ProofEvaluation | { ok: "unavailable" }> {
  if (read.kind === "unavailable") return { ok: "unavailable" };
  if (read.kind === "not_found") return { ok: false, reason: "comment_not_found" };
  const c = read.comment;
  if (c.issueUrl.toLowerCase() !== issueApiUrl(issue).toLowerCase()) return { ok: false, reason: "wrong_issue" };
  if (
    c.userId === null ||
    !Number.isInteger(c.userId) ||
    c.userId === GHOST_USER_ID ||
    !c.login ||
    c.login.toLowerCase() === "ghost" ||
    (c.userType !== "User" && c.userType !== "Bot")
  ) {
    return { ok: false, reason: "author_invalid" };
  }
  if (c.updatedAt !== c.createdAt || (c.lastEditedAt !== undefined && c.lastEditedAt !== null)) return { ok: false, reason: "comment_edited" };
  let matched = false;
  for (const raw of c.body.split("\n")) {
    const parts = parseProofLine(raw.replace(/\r$/, ""));
    if (parts && parts.nodeId === expect.nodeId && parts.challengeId === expect.challengeId && (await sha256Hex(parts.nonce)) === expect.nonceHash) {
      matched = true;
      break;
    }
  }
  if (!matched) return { ok: false, reason: "line_missing" };
  const created = Date.parse(c.createdAt);
  const skew = expect.commentSkewSec * 1000;
  if (Number.isNaN(created) || created < Date.parse(expect.issuedAt) - skew || created > Date.parse(expect.expiresAt) + skew) {
    return { ok: false, reason: "outside_window" };
  }
  return { ok: true, githubId: String(c.userId), login: c.login, userType: c.userType };
}

export interface GithubVerifierOptions {
  readonly fetch: typeof fetch;
  /**
   * An installation token with `issues: read` only, or null when the node holds none. With null the verifier reads unauthenticated unless
   * `requireToken` is set, and then answers `unavailable` (production fails closed).
   */
  readonly getToken: () => Promise<string | null>;
  /** Production: no token means `unavailable`. */
  readonly requireToken?: boolean;
}

async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    drain(res);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.length > MAX_BODY_BYTES ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Release the socket of a response whose body is not read (a non-200 answer). Not awaited: a cancel on a tee'd stream settles only when both branches do. */
const drain = (res: Response): void => {
  res.body?.cancel().catch(() => undefined);
};

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `createGithubCommentVerifier`: the GitHub REST comment read, plus (with a token) the GraphQL `lastEditedAt` read. */
export function createGithubCommentVerifier(options: GithubVerifierOptions): ProofVerifier {
  const call = async (url: string, init: RequestInit & { token: string | null }): Promise<Response | null> => {
    const { token, ...rest } = init;
    try {
      return await options.fetch(url, {
        ...rest,
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "cogni-agent-grants",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...((rest.headers as Record<string, string> | undefined) ?? {}),
        },
      });
    } catch {
      return null;
    }
  };

  return {
    async fetchComment({ issue, commentId }): Promise<CommentRead> {
      if (!Number.isSafeInteger(commentId) || commentId <= 0) return { kind: "not_found" };
      let token: string | null;
      try {
        token = await options.getToken();
      } catch {
        return { kind: "unavailable" };
      }
      if (!token && options.requireToken) return { kind: "unavailable" };

      const res = await call(githubCommentUrl(issue, commentId), { method: "GET", token });
      if (!res) return { kind: "unavailable" };
      if (res.status === 404) {
        drain(res);
        return { kind: "not_found" };
      }
      if (res.status !== 200) {
        drain(res);
        return { kind: "unavailable" };
      }
      const text = await readCapped(res).catch(() => null);
      if (text === null) return { kind: "unavailable" };
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { kind: "unavailable" };
      }
      const user = typeof json.user === "object" && json.user !== null ? (json.user as Record<string, unknown>) : null;
      const comment: ProofComment = {
        issueUrl: asString(json.issue_url) ?? "",
        userId: user && typeof user.id === "number" ? user.id : null,
        login: user ? asString(user.login) : null,
        userType: user ? asString(user.type) : null,
        body: asString(json.body) ?? "",
        createdAt: asString(json.created_at) ?? "",
        updatedAt: asString(json.updated_at) ?? "",
      };
      if (!token) return { kind: "found", comment };

      // With a token: an edit in the same second as the post leaves created_at == updated_at. GraphQL `lastEditedAt` does not.
      const nodeId = asString(json.node_id);
      if (!nodeId) return { kind: "unavailable" };
      const gql = await call("https://api.github.com/graphql", {
        method: "POST",
        token,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "query($id:ID!){node(id:$id){... on IssueComment{lastEditedAt}}}",
          variables: { id: nodeId },
        }),
      });
      if (!gql) return { kind: "unavailable" };
      if (gql.status !== 200) {
        drain(gql);
        return { kind: "unavailable" };
      }
      const gqlText = await readCapped(gql).catch(() => null);
      if (gqlText === null) return { kind: "unavailable" };
      try {
        const parsed = JSON.parse(gqlText) as { data?: { node?: { lastEditedAt?: string | null } | null }; errors?: unknown };
        if (parsed.errors || !parsed.data) return { kind: "unavailable" };
        if (parsed.data.node === null) return { kind: "not_found" };
        const edited = parsed.data.node?.lastEditedAt;
        if (edited === undefined) return { kind: "unavailable" };
        return { kind: "found", comment: { ...comment, lastEditedAt: edited } };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
