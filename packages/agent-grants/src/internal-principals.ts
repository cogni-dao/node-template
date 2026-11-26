// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants` internal principals
 * Purpose: Seeded internal agent principals: the users graphs act as (catalog slug -> user id).
 * Scope: Deterministic UUIDs and slugs. No authorization logic.
 * Invariants: IDs match the rows `migrations/agent_authority.sql` seeds. Each user has no credential, and AGENT_WALLET_IS_NOT_A_PAYEE
 *   keeps any wallet it binds out of payouts.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

/** `node-ai`: the general node agent (brain). `prioritizer`: the mission-loop scorer (work-prioritizer). */
export const NODE_AI_PRINCIPAL_SLUG = "node-ai" as const;
export const NODE_AI_PRINCIPAL_USER_ID = "00000000-0000-4000-a000-0000000a0001" as const;
export const PRIORITIZER_PRINCIPAL_SLUG = "prioritizer" as const;
export const PRIORITIZER_PRINCIPAL_USER_ID = "00000000-0000-4000-a000-0000000a0002" as const;
export const INTERNAL_AGENT_PRINCIPALS = [
  { slug: NODE_AI_PRINCIPAL_SLUG, userId: NODE_AI_PRINCIPAL_USER_ID },
  { slug: PRIORITIZER_PRINCIPAL_SLUG, userId: PRIORITIZER_PRINCIPAL_USER_ID },
] as const;
