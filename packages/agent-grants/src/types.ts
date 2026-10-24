// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/types`
 * Purpose: Boundary types shared by every agent-grants operation.
 * Scope: Types and the single error class only.
 * Invariants: identities cross the boundary as plain strings (users.id,
 *   billing_accounts.id); no node-specific scope type exists here.
 * Side-effects: none
 * @public
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * Any drizzle Postgres database or transaction. Callers pass an app-role
 * transaction whose tenant context (`app.current_user_id`) is already set to
 * the acting principal, except for credential helpers which take the
 * service-role database.
 */
export type AgentGrantsDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type AgentGrantsErrorCode =
  | "invalid_scope"
  | "invalid_expiry"
  | "pending_exists"
  | "conflict";

export class AgentGrantsError extends Error {
  readonly code: AgentGrantsErrorCode;

  constructor(code: AgentGrantsErrorCode, message: string) {
    super(message);
    this.name = "AgentGrantsError";
    this.code = code;
  }
}
