// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-admin`
 * Purpose: The one door for node-admin writes (ADMIN_ACTS_IN_ADMIN). Every method takes an `AdminSession` first, so a caller that
 *   never passed the Admin area's `requireAdminSession()` cannot call it: the type checker refuses.
 * Scope: Interface and the branded session type only. First slice: node-wide AI access; story.0038 adds connect from home (the provider's connected orgs and the customer's own connections). Epoch review, goal-layer merge and priority 0/1 join in task.0115.
 * Invariants:
 *   - ONE_MINT: the brand below is not exported. Only `src/app/(admin)/_lib/admin-session.ts` casts to `AdminSession` (an import-lock test fails on any other `as AdminSession`).
 *   - NO_NEW_AUTHORITY: an implementation delegates to the existing authority; it decides nothing itself.
 * Side-effects: none (interface definition only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard, tests/unit/app/admin-acts-in-admin.test.ts
 * @public
 */

import type { ConnectionView, NodeAiPermissionView, PrincipalRef } from "@cogni/agent-grants";

declare const adminSessionBrand: unique symbol;

/** An admin decision: a caller (session or bearer) the one node-admin check approved. Made only by `requireAdminSession()`. */
export type AdminSession = {
  readonly [adminSessionBrand]: true;
  readonly userId: string;
};

export interface AiPermissionTarget {
  readonly ref: PrincipalRef;
  readonly scope: string;
}

export interface AiPermissionChange {
  readonly principalUserId: string;
  readonly changed: boolean;
}

/** A connected org as the provider's page shows it. */
export interface ConnectedOrgRow extends ConnectionView {
  /** The customer's node id, only when this node's own `trusted_homes` entry names one. */
  readonly nodeId?: string;
}

/** A configured provider as the customer's page shows it, with this node's own connection state. */
export interface OutboundTarget {
  readonly alias: string;
  readonly origin: string;
  readonly offer?: string;
  readonly status: "connected" | "not_connected";
  readonly cap: number | null;
}

export type OutboundActOutcome =
  | {
      readonly ok: true;
      readonly alias: string;
      readonly act: "connect" | "disconnect";
      readonly httpStatus: number;
      readonly status: "connected" | "disconnected" | null;
      readonly error: string | null;
      readonly target: OutboundTarget;
    }
  | { readonly ok: false; readonly reason: "unknown_alias" | "no_signer" | "unreachable" };

export interface NodeAdminPort {
  /** The admin table of this node's AI permissions. */
  listNodeAi(session: AdminSession): Promise<{ permissions: NodeAiPermissionView[]; more: number }>;
  /** Turn a node-wide permission On: approve a pending ask, or grant one of this node's AI directly. */
  turnAiPermissionOn(session: AdminSession, target: AiPermissionTarget): Promise<AiPermissionChange>;
  /** Turn a live node-wide permission Off. */
  turnAiPermissionOff(session: AdminSession, target: AiPermissionTarget): Promise<AiPermissionChange>;
  /** Dismiss a pending ask (the agent then sees `denied`). */
  dismissAiRequest(session: AdminSession, target: AiPermissionTarget): Promise<AiPermissionChange>;
  /** The waiting node ask a one-time link token opens, as a table row to highlight; null for a wrong-kind, used, expired or unknown token. */
  previewAiRequest(session: AdminSession, token: string): Promise<NodeAiPermissionView | null>;
  /** PROVIDER: the connected orgs, ordered by issuer, at most `limit`; `nextAfter` pages. */
  listConnectedOrgs(
    session: AdminSession,
    input: { limit?: number | undefined; after?: string | null | undefined }
  ): Promise<{ orgs: ConnectedOrgRow[]; nextAfter: string | null }>;
  /** PROVIDER: Suspend (sticky) or Resume a connected org. False when the org has no record. */
  setConnectedOrgSuspended(session: AdminSession, input: { orgUserId: string; suspended: boolean }): Promise<boolean>;
  /** PROVIDER: one credit-ledger row on the record's billing account; null when the org has no record. `applied` is false when `key` was already applied. */
  grantConnectionAllowance(
    session: AdminSession,
    input: { orgUserId: string; credits: number; key: string }
  ): Promise<{ allowance: number; applied: boolean } | null>;
  /** CUSTOMER: the configured providers with this node's own state; `signer` is false when this node has no signing key. */
  listOutboundConnections(session: AdminSession): Promise<{ signer: boolean; targets: OutboundTarget[] }>;
  /** CUSTOMER: signs and sends one connect (with a cap) or disconnect to a configured provider and returns the provider's answer. */
  actOutboundConnection(
    session: AdminSession,
    input: { alias: string; act: "connect"; cap: number } | { alias: string; act: "disconnect" }
  ): Promise<OutboundActOutcome>;
}
