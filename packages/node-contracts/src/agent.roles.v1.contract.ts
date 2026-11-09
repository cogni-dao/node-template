// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.roles.v1`
 * Purpose: Zod contract for GET, POST and DELETE /api/v1/agent-access/roles on the HUMAN plane: a DAO admin lists node AI
 *   and allows or removes a permission (a node role) for an internal agent principal by clicking on the profile page.
 * Scope: Input and output wire shapes. Does not contain authorization logic.
 * Invariants: CONTRACTS_ARE_TRUTH. `principal` is the internal principal slug (catalog name), never a user id.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { z } from "zod";

export const agentRolesOperation = {
  id: "agent.roles.v1",
  input: z.object({
    /** Internal agent principal slug, e.g. `node-ai` or `prioritizer`. */
    principal: z.string().min(1).max(64),
    /** A scope the node's tool contracts declare, e.g. `knowledge:write`. */
    scope: z.string().min(1).max(100),
  }),
  output: z.object({
    principal: z.string(),
    scope: z.string(),
    principalUserId: z.string(),
    /** false when the grant already existed or the revoke found no live role. */
    changed: z.boolean(),
  }),
} as const;

/** Human-plane refusal body: any `Authorization` header on a human route gets 403 with this code. */
export const HUMAN_SESSION_REQUIRED = "human_session_required" as const;

/** `GET /api/v1/agent-access/roles`: what the "This node's AI" table renders. A non-admin gets `canManage: false`, `permissions: []`. */
export const agentRolesListOperation = {
  id: "agent.roles.list.v1",
  output: z.object({
    canManage: z.boolean(),
    permissions: z.array(
      z.object({
        principal: z.string(),
        ai: z.string(),
        scope: z.string(),
        permission: z.string(),
        allowed: z.boolean(),
      })
    ),
  }),
} as const;
