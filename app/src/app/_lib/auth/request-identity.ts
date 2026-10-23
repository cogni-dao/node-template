// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/request-identity`
 * Purpose: Unified request identity resolver — returns a SessionUser for
 *   either a valid HMAC-signed machine bearer token (`cogni_ag_sk_v1_...`)
 *   or a browser session cookie. One entry point for both auth surfaces.
 * Scope: Bearer parser + HMAC signer/verifier (issueAgentApiKey exported to
 *   the register route only), and resolveRequestIdentity which
 *   wrapRouteHandlerWithLogging consumes via `auth.getSessionUser`. Session IO
 *   happens via getServerSessionUser; the only DB read is the revocable
 *   credential lookup for keys that carry the signed `cred` claim.
 * Invariants:
 *   - NO_AUTH_CYCLE: imports getServerSessionUser DIRECTLY from @/lib/auth/server.
 *     Must NOT import getSessionUser from @/app/_lib/auth/session (that module
 *     re-exports this resolver and would create unbounded async recursion on
 *     every non-bearer request — candidate-a OOM class of bug).
 *   - BEARER_CLAIMS_EXCLUSIVE: when a bearer token is present but invalid,
 *     returns null (does not fall back to session cookies). Prevents a stolen
 *     cookie from winning when the client claimed machine identity.
 *   - REVOCABLE_CREDENTIALS (story.5115): every key issued now carries a signed
 *     `cred: true` claim and verifies only while a non-revoked agent_credentials
 *     row matches sha256(key) (service-role read via a lazy container import,
 *     so cookie-only requests never load the container). Legacy keys without
 *     the claim keep HMAC + exp semantics until they expire (≤30d, never
 *     renewed) — the transition window from node-capability-grants-standard.
 *   - NO_REDOS: extractBearerToken uses startsWith/slice (O(n)), not regex
 *     backtracking. Flagged by SonarQube on the original /^Bearer\s+(.+)$/i.
 * Side-effects: IO (next/headers read, NextAuth session fetch via server.ts,
 *   agent_credentials lookup for credentialed bearers).
 * Links: docs/spec/security-auth.md, docs/spec/identity-model.md
 * @public
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { isAgentCredentialLive } from "@cogni-dao/agent-grants";
import type { SessionUser } from "@cogni/node-shared";
import { headers } from "next/headers";
import { getServerSessionUser } from "@/lib/auth/server";
import { serverEnv } from "@/shared/env/server";

type AgentTokenPayload = {
  sub: string;
  displayName: string | null;
  iat: number;
  exp: number;
  /** Present on keys issued with a revocable agent_credentials row. */
  cred?: true;
};

const TOKEN_PREFIX = "cogni_ag_sk_v1_";
const AGENT_KEY_TTL_SECONDS = 60 * 60 * 24 * 30;

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  // Avoid regex backtracking: use startsWith + slice (O(n), no ReDoS risk).
  // Flagged by SonarQube on /^Bearer\s+(.+)$/i — the (.+) group allowed
  // super-linear backtracking on crafted Authorization headers.
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trimStart();
  return token || null;
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", serverEnv().AUTH_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

function parseAgentToken(token: string): AgentTokenPayload | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const encoded = token.slice(TOKEN_PREFIX.length);
  const [payloadB64, signature] = encoded.split(".");
  if (!payloadB64 || !signature) return null;
  const expected = signPayload(payloadB64);
  if (!safeCompare(signature, expected)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as AgentTokenPayload;
    if (!parsed.sub) return null;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function issueAgentApiKey(input: {
  userId: string;
  displayName: string | null;
}): string {
  const payload: AgentTokenPayload = {
    sub: input.userId,
    displayName: input.displayName,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + AGENT_KEY_TTL_SECONDS,
    cred: true,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  return `${TOKEN_PREFIX}${payloadB64}.${signPayload(payloadB64)}`;
}

/**
 * Verify a bearer key: HMAC + exp, and — for credentialed keys — a live
 * agent_credentials row. Returns the signed payload or null.
 */
export async function verifyAgentApiKey(
  token: string
): Promise<AgentTokenPayload | null> {
  const payload = parseAgentToken(token);
  if (!payload) return null;
  if (payload.cred !== true) return payload; // legacy key: transition window
  const { resolveServiceDb } = await import("@/bootstrap/container");
  const live = await isAgentCredentialLive(resolveServiceDb(), {
    userId: payload.sub,
    key: token,
  });
  return live ? payload : null;
}

/** The raw bearer key on the current request, if any. */
export async function getRequestBearerToken(): Promise<string | null> {
  try {
    return extractBearerToken((await headers()).get("authorization"));
  } catch {
    return null;
  }
}

function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function resolveRequestIdentity(): Promise<SessionUser | null> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return getServerSessionUser();
  }
  const bearer = extractBearerToken(h.get("authorization"));
  if (bearer) {
    const payload = await verifyAgentApiKey(bearer);
    if (!payload) return null;
    return {
      id: payload.sub,
      walletAddress: null,
      displayName: payload.displayName,
      avatarColor: null,
    };
  }

  if (!isSameOrigin(h.get("origin"), h.get("host"))) {
    return null;
  }

  return getServerSessionUser();
}

/**
 * Browser-session identity only: any bearer (even a valid agent key) is
 * rejected. For human decisions such as approving an agent access request.
 */
export async function resolveHumanSessionIdentity(): Promise<SessionUser | null> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return null;
  }
  if (h.get("authorization")) return null;
  if (!isSameOrigin(h.get("origin"), h.get("host"))) return null;
  return getServerSessionUser();
}
