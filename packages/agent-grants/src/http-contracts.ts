// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/http` contracts
 * Purpose: The fleet's wire contracts (zod) for the agent access routes: the admin AI-access table (`/api/v1/admin/ai-access`), the person's own table
 *   (`/api/v1/agent-access/mine`), the preview of a waiting ask, and an outside AI's access requests (`/api/v1/agent/access-requests`).
 * Scope: Wire shapes. No authorization logic. A node's route files import them from here; none keeps a copy (task.0175).
 * Invariants: CONTRACTS_ARE_TRUTH. HUMAN_SURFACE_TOKENLESS: a person never types or copies a token; the page reads it from the link fragment and sends it back.
 *   The approver is the signed-in person: a body never names an approver or an account of its own.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import { z } from "zod";

export const agentRolesOperation = {
  id: "agent.roles.v1",
  /**
   * Turn a row ON (POST) or OFF (DELETE). Name the agent by `principalUserId` (the id the table sends back, any agent) or,
   * for this node's own AI, by `principal` (catalog slug). `deny: true` on DELETE dismisses a pending ask.
   */
  input: z
    .object({
      /** Internal agent principal slug, e.g. `node-ai` or `prioritizer`. */
      principal: z.string().min(1).max(64).optional(),
      /** The agent's id, as the table returned it. Works for outside agents. */
      principalUserId: z.string().min(1).max(100).optional(),
      /** A scope the node declares, e.g. `knowledge:write`. */
      scope: z.string().min(1).max(100),
      deny: z.boolean().optional(),
    })
    .refine((v) => (v.principal === undefined) !== (v.principalUserId === undefined), {
      message: "send exactly one of principal or principalUserId",
    }),
  output: z.object({
    principal: z.string().optional(),
    scope: z.string(),
    principalUserId: z.string(),
    /** false when the grant already existed, the revoke found no live row, or the deny found no pending ask. */
    changed: z.boolean(),
  }),
} as const;

/** Human-plane refusal body: any `Authorization` header on a human route gets 403 with this code. */
export const HUMAN_SESSION_REQUIRED = "human_session_required" as const;

/**
 * `GET /api/v1/agent-access/roles`: what the "AI access" table renders. A non-admin gets `canManage: false`, `permissions: []`.
 * One row = one grant row. Name and description come from the declaration; the agent's name from `agent_principals` or the user.
 */
/** One row of the "AI access" table, shared by the admin list and the profile list. */
export const agentAccessRowSchema = z.object({
  section: z.enum(["pending", "node", "outside"]),
  principalUserId: z.string(),
  who: z.string(),
  outside: z.boolean(),
  hint: z.string().nullable(),
  scope: z.string(),
  label: z.string(),
  description: z.string(),
  on: z.boolean(),
  until: z.string().nullable(),
  resource: z.enum(["node", "account"]),
  rowId: z.string().nullable(),
  viaLink: z.boolean().optional(),
});

export const agentRolesListOperation = {
  id: "agent.roles.list.v1",
  output: z.object({
    canManage: z.boolean(),
    permissions: z.array(agentAccessRowSchema),
    /** Outside rows left out because the list is bounded. */
    more: z.number().int().nonnegative(),
  }),
} as const;



/** A one-time link token: 43 base64url characters. */
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const agentMineListOperation = {
  id: "agent.mine.list.v1",
  output: z.object({
    permissions: z.array(agentAccessRowSchema),
    /** Rows left out because the list is bounded. */
    more: z.number().int().nonnegative(),
  }),
} as const;

export const agentMineOnOperation = {
  id: "agent.mine.on.v1",
  /**
   * Turn a row On. Send exactly one of: `token` (an outside AI's ask, from its link) or `principalUserId` + `scope` (this node's own AI, no ask).
   * An account grant has no end date: it lasts until Off, like a node permission.
   */
  input: z
    .object({
      token: tokenSchema.optional(),
      principalUserId: z.string().min(1).max(100).optional(),
      scope: z.string().min(1).max(100).optional(),
      /** With `token` only: an org account the signed-in person co-owns (through the org's owner source) and decides for. Absent = the person's own account. */
      accountId: z.string().min(1).max(100).optional(),
    })
    .refine(
      (v) =>
        (v.token !== undefined && v.principalUserId === undefined && v.scope === undefined) ||
        (v.token === undefined && v.principalUserId !== undefined && v.scope !== undefined && v.accountId === undefined),
      { message: "send a token, or principalUserId with scope" }
    ),
  output: z.object({ changed: z.boolean() }),
} as const;

export const agentMineOffOperation = {
  id: "agent.mine.off.v1",
  /** Turn a live row Off by its id, or dismiss a waiting ask with `deny: true` and its token (an undecided ask has no account yet). */
  input: z
    .object({
      rowId: z.string().uuid().optional(),
      token: tokenSchema.optional(),
      deny: z.literal(true).optional(),
      /** With `token` and `deny`: an org account the signed-in person co-owns and dismisses the ask for. */
      accountId: z.string().min(1).max(100).optional(),
    })
    .refine(
      (v) =>
        (v.rowId !== undefined && v.token === undefined && v.deny === undefined && v.accountId === undefined) ||
        (v.rowId === undefined && v.token !== undefined && v.deny === true),
      { message: "send a rowId, or a token with deny" }
    ),
  output: z.object({ changed: z.boolean() }),
} as const;

export const agentPreviewOperation = {
  id: "agent.preview.v1",
  input: z.object({ token: tokenSchema }),
  /** The waiting ask the token opens, as a table row. A wrong-kind, used, expired or unknown token is one 404. */
  output: z.object({ permission: agentAccessRowSchema }),
} as const;

/** `expired` is a state read from the row's end date (R14): an account grant whose time passed. */
export const agentAccessRequestStateSchema = z.enum(["pending", "granted", "denied", "revoked", "expired"]);

export const agentAccessRequestCreateOperation = {
  id: "agent.access-requests.create.v1",
  input: z.object({
    /** A scope this node declares. Anything else is 400 `invalid_scope`. */
    scope: z.string().min(1).max(100),
  }),
  output: z.object({
    scope: z.string(),
    /** `pending` = asked and waiting; `granted` = already live. */
    state: z.enum(["pending", "granted"]),
    /** false when the ask (or grant) already existed. */
    created: z.boolean(),
    /**
     * The one link to hand the person who decides: `/admin/ai-access#agent-request=<token>` for a node permission, `/profile#agent-request=<token>`
     * for an account permission, picked by the permission's declared kind. One-time, 24 hours; every ask on a waiting row returns a new one.
     * Absent when the grant is already live.
     */
    approvalUrl: z.string().url().optional(),
  }),
} as const;

export const agentAccessRequestListOperation = {
  id: "agent.access-requests.list.v1",
  output: z.object({
    requests: z.array(
      z.object({
        scope: z.string(),
        state: agentAccessRequestStateSchema,
        at: z.string(),
        /** The account an account grant covers (set once its owner decided); null for a node permission and for a waiting ask. */
        accountId: z.string().nullable(),
      })
    ),
  }),
} as const;
