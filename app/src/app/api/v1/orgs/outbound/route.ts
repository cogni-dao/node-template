// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/outbound`
 * Purpose: This node's admin makes THIS node sign a link or unlink for an org on another node (task.0181): POST `{ act, targetOrigin, targetNodeId, orgUserId, code?, services? }`.
 *   The node signs one assertion as its service `node-connect` for the target's audience and posts it once to the target's `/api/v1/orgs/link`.
 * Scope: HTTP validation, the one admin check and delegation to `container.orgAccounts.signOutbound`. A person's cookie session only. Only a node admin can make this node sign
 *   (LINK_NEEDS_BOTH_SIDES): the org owner's code on the other node is not enough.
 * Invariants:
 *   - ONE_ADMIN_CHECK: a non-admin is 403 `authz_denied`; no configured admins 503 `authz_unavailable`.
 *   - FAIL_CLOSED: no signing key is 503 `signer_unavailable`; a target origin that is not a canonical https origin is 400 `invalid_origin`; an unreachable target is 502 `target_unreachable`.
 *   - NO_TOKEN_IN_LOGS: `org.outbound_link` carries the act, the target origin, the status and the target's short error code, never the code or the assertion.
 * Side-effects: IO (one signed HTTPS POST to another node)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgOutboundLinkOperation } from "@cogni/node-contracts";
import { json, readJson } from "@/app/api/v1/orgs/_lib/org-http";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "orgs.outbound-link", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (_ctx, request, sessionUser) => {
    const container = getContainer();
    const admin = await container.agentAuthority.adminCheck(sessionUser.id).catch(() => "unavailable" as const);
    if (admin === "unavailable") return json({ error: "authz_unavailable" }, 503);
    if (admin !== "allow") return json({ error: "authz_denied" }, 403);
    const parsed = orgOutboundLinkOperation.input.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    const result = await container.orgAccounts.signOutbound(parsed.data);
    if (!result.ok) {
      if (result.reason === "no_signer") return json({ error: "signer_unavailable" }, 503);
      if (result.reason === "invalid_origin") return json({ error: "invalid_origin" }, 400);
      if (result.reason === "invalid_input") return json({ error: "invalid input" }, 400);
      return json({ error: "target_unreachable" }, 502);
    }
    return json(orgOutboundLinkOperation.output.parse({ httpStatus: result.httpStatus, error: result.error, act: result.act }));
  }
);
