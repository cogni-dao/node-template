// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants` principal rows
 * Purpose: The one writer of an outside agent's `agent_principals` row and the one reader of a user's kind.
 * Scope: Raw SQL over an injected tag. The caller owns the transaction and the service-role connection (`agent_principals` is writable only by BYPASSRLS).
 * Invariants:
 *   - ONE_PRINCIPAL_WRITER: registration writes the external row through `writeExternalPrincipal`, idempotently, in the same transaction as the user. Key upgrade only reads it.
 *   - KIND_IS_THE_ROW: a user is an `org` when its row has kind org, an `agent` for any other row; no row is a `human`.
 * Side-effects: IO
 * @public
 */

import type { SqlTag } from "./postgres";

/** Mark `userId` as an outside agent. Idempotent: a user already marked (internal or external) keeps its row. */
export async function writeExternalPrincipal(tx: SqlTag, userId: string): Promise<void> {
  await tx`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${userId}) ON CONFLICT (user_id) DO NOTHING`;
}

/** What a user is: `org` (an `agent_principals` row of kind org), `agent` (any other row) or `human` (no row). */
export type PrincipalKind = "agent" | "human" | "org";

export async function principalKindOf(sql: SqlTag, userId: string): Promise<PrincipalKind> {
  const rows = await sql`SELECT kind FROM agent_principals WHERE user_id = ${userId} LIMIT 1`;
  if (rows.length === 0) return "human";
  return rows[0]?.kind === "org" ? "org" : "agent";
}

/** What an actor recorded on a write is: this node's AI, an outside AI, a signed-in person, the node's own system principal, or unknown. */
export type PrincipalClass = "internal" | "external" | "human" | "system" | "unclassified";

/**
 * The one classifier of a write's actor (hub activity-attribution, task.0133). Kind is never stored on a write; it is read here.
 * `system` is a user id the host names as one of the node's own system principals (`cogni_system`, and the DAO approver principal
 * where one is seeded). Otherwise the `agent_principals` row decides internal or external (an org row is `unclassified`); a user with no
 * principal row is `human` only when a `users` row exists; an id with neither is `unclassified`.
 */
export async function classifyPrincipal(
  sql: SqlTag,
  userId: string,
  systemUserIds: readonly string[]
): Promise<PrincipalClass> {
  if (systemUserIds.includes(userId)) return "system";
  const principals = await sql`SELECT kind FROM agent_principals WHERE user_id = ${userId} LIMIT 1`;
  const kind = (principals[0] as { kind?: unknown } | undefined)?.kind;
  if (kind === "internal" || kind === "external") return kind;
  // Any other principal row (an org) is not an AI, a person or the node itself: it never acts, so it is not classified.
  if (kind !== undefined) return "unclassified";
  const users = await sql`SELECT 1 AS present FROM users WHERE id = ${userId} LIMIT 1`;
  return users.length > 0 ? "human" : "unclassified";
}
