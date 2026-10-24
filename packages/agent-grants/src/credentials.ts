// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials`
 * Purpose: Revocable agent credentials — sha256 key hashing, issuance record,
 *   liveness lookup, and self-revocation.
 * Scope: Service-role Postgres reads/writes on agent_credentials (the table is
 *   deny-all for the app role).
 * Invariants:
 *   - CREDENTIAL_HASH_ONLY: raw keys and approval tokens are never persisted
 *     or returned from storage; only sha256 hex digests are stored.
 *   - REVOKE_IS_SOFT: revocation sets revoked_at; rows are never deleted.
 * Side-effects: IO (Postgres), randomness (approval tokens)
 * @public
 */

import { createHash, randomBytes } from "node:crypto";
import { agentCredentials } from "@cogni/db-schema/agent-grants";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { AgentGrantsDb } from "./types";

/** sha256 hex digest of an opaque key or token. */
export function hashAgentKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** A fresh one-time approval token and the hash that is persisted. */
export function mintApprovalToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashAgentKey(token) };
}

export async function recordAgentCredential(
  serviceDb: AgentGrantsDb,
  input: { userId: string; key: string }
): Promise<void> {
  await serviceDb
    .insert(agentCredentials)
    .values({ userId: input.userId, keyHash: hashAgentKey(input.key) });
}

/** True only when an unrevoked credential row for this exact key exists. */
export async function isAgentCredentialLive(
  serviceDb: AgentGrantsDb,
  input: { userId: string; key: string }
): Promise<boolean> {
  const [row] = await serviceDb
    .select({ id: agentCredentials.id })
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.keyHash, hashAgentKey(input.key)),
        eq(agentCredentials.userId, input.userId),
        isNull(agentCredentials.revokedAt)
      )
    )
    .limit(1);
  return Boolean(row);
}

/** Revokes the presented key. Returns the credential id, or null if none was live. */
export async function revokeAgentCredential(
  serviceDb: AgentGrantsDb,
  input: { userId: string; key: string }
): Promise<string | null> {
  const [row] = await serviceDb
    .update(agentCredentials)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(agentCredentials.keyHash, hashAgentKey(input.key)),
        eq(agentCredentials.userId, input.userId),
        isNull(agentCredentials.revokedAt)
      )
    )
    .returning({ id: agentCredentials.id });
  return row?.id ?? null;
}
