// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/requests`
 * Purpose: The body of ONE ask's approval page, for the person who decides it: the owner (profile page) or a node-admin (Admin page).
 * Scope: Pure over the store port. The route has already checked the session (person session, or the admin mint); this decides only whether THIS request is theirs to see.
 * Invariants:
 *   - APPROVER_FOLLOWS_RESOURCE: the owner sees a request only when the agent is theirs and the row is personal. An admin sees only a node row an admin may decide:
 *     not an ask of an agent that has an owner for a scope the owner may delegate. Anything else is `null`, which the route renders as the same 404 as an unknown id.
 *   - TOKENLESS_COPY: the view holds names and the plain permission text from the declaration; the ids are the handles the approve click sends back.
 *   - NEVER_CACHED: every call reads the store.
 * Side-effects: IO (store reads)
 * @public
 */

import { personalKindFor, type ScopeDeclaration } from "./roles";
import type { AgentGrantsStore, RequestRecord, RequestView } from "./types";

type Declarations = Readonly<Record<string, { readonly label?: string | undefined; readonly description?: string | undefined }>>;

const NEUTRAL_WHO = "Unnamed agent";

function toView(record: RequestRecord, declarations: Declarations): RequestView | null {
  const d = declarations[record.scope];
  if (!d?.label || !d.description) return null;
  return {
    requestId: record.id,
    principalUserId: record.principalUserId,
    scope: record.scope,
    who: record.agentName?.trim() || NEUTRAL_WHO,
    owner: record.ownerName?.trim() || (record.ownerUserId ? "Unnamed person" : null),
    label: d.label,
    description: d.description,
    state: record.state,
    until: record.state === "granted" ? record.expiresAt : null,
  };
}

/** The request as its owner sees it, or null (not found, someone else's, or a node row). */
export async function requestViewForOwner(
  store: AgentGrantsStore,
  input: { ownerUserId: string; requestId: string; declarations: Declarations }
): Promise<RequestView | null> {
  const record = await store.getRequest(input.requestId);
  if (!record || record.resourceKind === "node" || record.ownerUserId !== input.ownerUserId) return null;
  return toView(record, input.declarations);
}

/** The request as a node-admin sees it, or null (not found, a personal row, or an ask the owner decides). */
export async function requestViewForAdmin(
  store: AgentGrantsStore,
  input: { requestId: string; declarations: Declarations; scopes: Readonly<Record<string, ScopeDeclaration>> }
): Promise<RequestView | null> {
  const record = await store.getRequest(input.requestId);
  if (!record || record.resourceKind !== "node") return null;
  const declaration = input.scopes[record.scope];
  const ownersToDecide = record.state === "pending" && !record.internal && record.ownerUserId !== null && personalKindFor(record.scope, declaration) !== null;
  if (ownersToDecide) return null;
  return toView(record, input.declarations);
}
