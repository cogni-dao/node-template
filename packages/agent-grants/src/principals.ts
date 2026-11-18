// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants` principal rows
 * Purpose: The one writer of an outside agent's `agent_principals` row and the one reader of a user's kind.
 * Scope: Raw SQL over an injected tag. The caller owns the transaction and the service-role connection (`agent_principals` is writable only by BYPASSRLS).
 * Invariants:
 *   - ONE_PRINCIPAL_WRITER: registration writes the external row through `writeExternalPrincipal`, idempotently, in the same transaction as the user. Key upgrade only reads it.
 *   - KIND_IS_THE_ROW: a user is an `agent` exactly when it has an `agent_principals` row; no row is a `human`.
 * Side-effects: IO
 * @public
 */

import type { SqlTag } from "./postgres";

/** Mark `userId` as an outside agent. Idempotent: a user already marked (internal or external) keeps its row. */
export async function writeExternalPrincipal(tx: SqlTag, userId: string): Promise<void> {
  await tx`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${userId}) ON CONFLICT (user_id) DO NOTHING`;
}

/** `agent` when the user has an `agent_principals` row (any kind), else `human`. */
export async function principalKindOf(sql: SqlTag, userId: string): Promise<"agent" | "human"> {
  const rows = await sql`SELECT 1 AS marked FROM agent_principals WHERE user_id = ${userId} LIMIT 1`;
  return rows.length > 0 ? "agent" : "human";
}
