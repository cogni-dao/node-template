// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.request.v1`
 * Purpose: Zod contracts for ONE ask's approval page, on the HUMAN plane (session only): the page shows only that request (the AI, its owner, the permission in plain words,
 *   its state) and offers Approve and Deny. The owner reads it at `GET /api/v1/agent-access/mine/requests/{id}`; a node-admin at `GET /api/v1/admin/ai-access/requests/{id}`.
 *   An EXISTING agent becomes its owner's by an agent-initiated claim: `POST /api/v1/agent/claim` (AI plane, bearer) returns a claim page; the person's click claims it.
 * Scope: Wire shapes. Authority lives in the routes and `@cogni-dao/agent-grants`.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH. An answer of "no" (unknown id, someone else's request, a request the caller may not decide) is one 404 `not_found`.
 *   - HUMAN_SURFACE_TOKENLESS: the view holds names and plain text. `principalUserId` and `scope` are the opaque handles the Approve and Deny click sends back.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard, https://cognidao.org/work/items/task.5465
 * @public
 */

import { z } from "zod";

export const agentRequestViewOperation = {
  id: "agent.request.view.v1",
  output: z.object({
    requestId: z.string(),
    principalUserId: z.string(),
    scope: z.string(),
    /** The AI, by its identifier. */
    who: z.string(),
    /** The person who owns the AI, or null when it has none. */
    owner: z.string().nullable(),
    label: z.string(),
    description: z.string(),
    /** `ended` = approved once, now past its end. */
    state: z.enum(["pending", "granted", "denied", "revoked", "ended"]),
    until: z.string().nullable(),
  }),
} as const;

/** The click on an approval page: `POST /api/v1/agent-access/mine/requests/{id}`. */
export const agentRequestDecisionOperation = {
  id: "agent.request.decision.v1",
  input: z.object({ decision: z.enum(["approve", "deny"]) }),
  output: z.object({
    requestId: z.string(),
    decision: z.enum(["approve", "deny"]),
    /** false when nothing changed. */
    changed: z.boolean(),
  }),
} as const;

/** `POST /api/v1/agent/claim` (AI plane, bearer, no body): an existing agent asks to become its owner's. The answer is the page the person opens. */
export const agentClaimStartOperation = {
  id: "agent.claim.start.v1",
  output: z.object({
    /** The link to hand the person who will own this agent. Single use, 15 minutes, bound to this agent. */
    claimUrl: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
} as const;

/** `GET /api/v1/profile/ai/claims/{id}` (human plane): what the claim page shows. `POST` on the same path is the click. */
export const agentClaimViewOperation = {
  id: "agent.claim.view.v1",
  output: z.object({
    claimId: z.string(),
    /** The agent, by its registered name. */
    agentName: z.string().nullable(),
    state: z.enum(["open", "claimed", "expired", "owned"]),
    expiresAt: z.string(),
  }),
} as const;

export const agentClaimCompleteOperation = {
  id: "agent.claim.complete.v1",
  output: z.object({ claimed: z.literal(true) }),
} as const;
