// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/orgs/outbound`
 * Purpose: This node's admin links THIS node to an org on another node, or unlinks it (task.0181). The admin enters only the link code; the other node's origin, node id and the org id
 *   come from the code. POST `{ step: "preview", code }` asks that node what the code is for and returns the org's name and its origin; POST `{ step: "link", code, expectOrgName,
 *   services }` signs `act: "link"` as service `node-connect` ONLY if a fresh preview still names the confirmed org; POST `{ step: "unlink", code }` signs the close.
 * Scope: HTTP validation, the one admin check and delegation to `container.orgAccounts`. A person's cookie session only. Only a node admin can make this node sign
 *   (LINK_NEEDS_BOTH_SIDES): the org owner's code on the other node is not enough.
 * Invariants:
 *   - ONE_ADMIN_CHECK: a non-admin is 403 `authz_denied`; no configured admins 503 `authz_unavailable`.
 *   - CODE_NAMES_THE_TARGET, ONE_REQUEST_PATH: every request to the other node goes through the pinned request path (https only, no redirect, 5 s including the lookup, 64 KB, private
 *     ranges refused).
 *   - FAIL_CLOSED: a code that is not a link code is 400 `invalid_code`; a code the other node does not know is 404 `code_not_found`; an origin mismatch is 502 `preview_mismatch`; a name
 *     that changed since the admin confirmed is 409 `preview_changed`; no signing key is 503 `signer_unavailable`; an unreachable node is 502 `target_unreachable`.
 *   - NO_TOKEN_IN_LOGS: `org.outbound_link` carries the act, the target origin, the status and the target's short error code, never the code or the assertion.
 * Side-effects: IO (pinned HTTPS requests to another node)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { orgOutboundLinkOperation } from "@cogni/node-contracts";
import { json, readJson } from "@/app/api/v1/orgs/_lib/org-http";
import type { OutboundRefusal } from "@/bootstrap/org-accounts";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REFUSAL: Record<OutboundRefusal, { status: number; error: string }> = {
  invalid_code: { status: 400, error: "invalid_code" },
  invalid_input: { status: 400, error: "invalid input" },
  code_not_found: { status: 404, error: "code_not_found" },
  preview_mismatch: { status: 502, error: "preview_mismatch" },
  preview_changed: { status: 409, error: "preview_changed" },
  no_signer: { status: 503, error: "signer_unavailable" },
  unreachable: { status: 502, error: "target_unreachable" },
};

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "orgs.outbound-link", auth: { mode: "required", getSessionUser: getServerSessionUser } },
  async (_ctx, request, sessionUser) => {
    const container = getContainer();
    const admin = await container.agentAuthority.adminCheck(sessionUser.id).catch(() => "unavailable" as const);
    if (admin === "unavailable") return json({ error: "authz_unavailable" }, 503);
    if (admin !== "allow") return json({ error: "authz_denied" }, 403);
    const parsed = orgOutboundLinkOperation.input.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    const input = parsed.data;
    if (input.step === "preview") {
      const result = await container.orgAccounts.previewOutbound(input.code);
      if (!result.ok) return json({ error: REFUSAL[result.reason].error }, REFUSAL[result.reason].status);
      return json(orgOutboundLinkOperation.output.parse({ step: "preview", orgName: result.preview.orgName, origin: result.preview.origin }));
    }
    const result = await container.orgAccounts.signOutbound({
      act: input.step,
      code: input.code,
      ...(input.step === "link" ? { services: input.services, expectOrgName: input.expectOrgName } : {}),
    });
    if (!result.ok) return json({ error: REFUSAL[result.reason].error }, REFUSAL[result.reason].status);
    return json(orgOutboundLinkOperation.output.parse({ step: input.step, httpStatus: result.httpStatus, error: result.error, act: result.act }));
  }
);
