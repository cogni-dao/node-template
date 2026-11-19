// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/connections.v1`
 * Purpose: Zod contracts for connect from home (story.0038, `@cogni-dao/agent-grants` 0.10.0). Four routes, two sides:
 *   - Provider, public: POST /api/v1/public/agent/service-connections. A customer node signs `act`, `cap` and `seq` as an assertion of service `node-connect`; the provider answers
 *     with the record's resulting status, cap and seq.
 *   - Provider, admin: GET /api/v1/admin/connected-orgs (bounded, paged), POST /api/v1/admin/connected-orgs/{orgUserId}/allowance, .../suspension and .../seq-reset.
 *   - Customer, admin: GET and POST /api/v1/admin/connections (the node's own targets and the signed connect or disconnect it sends).
 * Scope: Bodies and outputs only. The caller on every admin route is the one admin check (a session or a bearer); the connect route's caller is its signed assertion, never its body.
 * Invariants: CONTRACTS_ARE_TRUTH. CREDITS_ARE_INTEGERS: every amount is an integer count of credits (10,000,000 per USD). A refusal carries a plain error code.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { z } from "zod";

/** The largest amount a body may carry: a safe integer, so JSON and the database agree on it. */
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The connect route's answer: the record as it stands after the call. A refusal is `{ error }` with 401, 400 or 409 (`stale_seq` and `seq_jump` also carry the stored `seq`). */
export const serviceConnectionOperation = {
  id: "agent.service-connection.v1",
  /** The body is ignored: the signed claims are the request. An empty object is expected. */
  input: z.object({}).passthrough(),
  output: z.object({
    status: z.enum(["connected", "disconnected"]),
    cap: count,
    seq: count,
  }),
} as const;

export const CONNECTED_ORG_STATUSES = ["connected", "suspended", "disconnected"] as const;

const connectedOrg = z.object({
  orgUserId: z.string().min(1),
  /** The customer's signing issuer origin: the record's key. */
  issuer: z.string().url(),
  /** The customer's node id, only when the provider's own `trusted_homes` entry names one. */
  nodeId: z.string().optional(),
  /** `suspended` wins over `connected` and `disconnected`. */
  status: z.enum(CONNECTED_ORG_STATUSES),
  /** Credits the provider granted that are left (the balance of the record's billing account). */
  allowance: z.number().int(),
  /** Credits the customer's runs have used so far. */
  debits: count,
  /** The cap the customer set. */
  cap: count,
  /** When the last run was billed to the record, or null. */
  lastCallAt: z.string().nullable(),
});

export const connectedOrgsListOperation = {
  id: "admin.connected-orgs.list.v1",
  input: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** The `nextAfter` of the previous page. */
    after: z.string().max(300).optional(),
  }),
  output: z.object({
    orgs: z.array(connectedOrg),
    /** The issuer to pass as `after` for the next page, or null at the end. */
    nextAfter: z.string().nullable(),
  }),
} as const;

export const connectedOrgAllowanceOperation = {
  id: "admin.connected-orgs.allowance.v1",
  /** `credits` is added to the record's balance as ONE ledger row (reason `connection_allowance`). `Idempotency-Key` (a header) makes a retry add nothing. */
  input: z.object({ credits: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
  output: z.object({
    orgUserId: z.string(),
    /** The record's balance after the grant. */
    allowance: z.number().int(),
    /** False when the idempotency key had already been applied (nothing was added). */
    applied: z.boolean(),
  }),
} as const;

export const connectedOrgSuspensionOperation = {
  id: "admin.connected-orgs.suspension.v1",
  /** `suspended: true` is Suspend (sticky: a connect never clears it); `false` is Resume. */
  input: z.object({ suspended: z.boolean() }),
  output: z.object({ orgUserId: z.string(), suspended: z.boolean() }),
} as const;

export const connectedOrgSeqResetOperation = {
  id: "admin.connected-orgs.seq-reset.v1",
  /** Puts the record's stored `seq` back to 1 (a record a stolen key pushed up). No body. */
  output: z.object({ orgUserId: z.string(), seq: z.literal(1) }),
} as const;

const outboundTarget = z.object({
  alias: z.string(),
  origin: z.string().url(),
  /** Static offer text from this node's own config; the provider is never asked. */
  offer: z.string().optional(),
  /** What this node last asked and the provider accepted. `not_connected` also covers a disconnect. */
  status: z.enum(["connected", "not_connected"]),
  /** The cap last accepted by the provider, or null when not connected. */
  cap: count.nullable(),
});

export const connectionsListOperation = {
  id: "admin.connections.list.v1",
  output: z.object({
    /** False when this node has no signing key: it cannot connect anywhere. */
    signer: z.boolean(),
    targets: z.array(outboundTarget),
  }),
} as const;

export const connectionActOperation = {
  id: "admin.connections.act.v1",
  input: z.discriminatedUnion("act", [
    z.object({ act: z.literal("connect"), alias: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), cap: count }),
    z.object({ act: z.literal("disconnect"), alias: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/) }),
  ]),
  output: z.object({
    alias: z.string(),
    act: z.enum(["connect", "disconnect"]),
    /** The provider's HTTP status. */
    httpStatus: z.number().int(),
    /** The provider's answer: the record's status after the call, or null when it refused. */
    status: z.enum(["connected", "disconnected"]).nullable(),
    /** The provider's plain refusal code (`invalid_token`, `stale_seq`, `invalid_claims`, `too_many_requests` ...), or null. */
    error: z.string().nullable(),
    target: outboundTarget,
  }),
} as const;
