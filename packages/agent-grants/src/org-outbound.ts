// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/org-outbound`
 * Purpose: This node as the OTHER node in a link (task.0181): the node's admin enters only the link code; this module previews the code at the node that made it, so the admin can confirm
 *   which org they are about to act for, then signs one `act: "link"` assertion as service `node-connect` (or an `act: "unlink"`) for that node's audience and posts it once.
 * Scope: The whole outbound protocol over an injected request function and signer: preview response validation, origin matching, mandatory fresh confirmation, signing eligibility, the
 *   post and the response interpretation. No route, no auth, no logging beyond the `onSent` callback the host passes. The host injects `createPinnedHttp` from `./jwks-fetch` (Node) as `http`.
 * Invariants:
 *   - CODE_NAMES_THE_TARGET: the target's origin, node id and the org id come from the code (`parseLinkCode`), never from the admin's input.
 *   - CONFIRM_THEN_SIGN: a link is signed only if a FRESH preview still names the org name the admin confirmed (`expectOrgName`), so the admin's confirmation is of what will be signed.
 *   - ORIGIN_MATCHES_THE_CODE: the node that answers a preview must name the origin the code names, or the preview is refused.
 *   - ONLY_THE_SECRET_IS_SIGNED: the signed `code` claim is the secret, never the full code; an unlink signs act and org only.
 *   - NO_SECRET_IN_RESULTS: a refusal is a short code; the target's error text is kept only when it is a short plain code; nothing carries the code or the assertion.
 * Side-effects: IO (the injected requests)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import {
  LINK_PATH,
  LINK_PREVIEW_PATH,
  type LinkPreview,
  type ParsedLinkCode,
  parseLinkCode,
  signLinkAssertion,
} from "./org-links";
import type { ServiceAssertionSigner } from "./service-auth";

/** One request to another node's origin (https, no redirect, bounded): the host injects `createPinnedHttp()`. A refusal or failure throws; a non-2xx status is returned. */
export type OutboundHttp = (
  uri: string,
  init?: { method?: "GET" | "POST"; headers?: Readonly<Record<string, string>>; body?: string }
) => Promise<{ readonly status: number; readonly body: string }>;

/** Why an outbound preview or link did not happen. A plain code, never a body. */
export type OutboundRefusal = "invalid_code" | "no_signer" | "unreachable" | "code_not_found" | "preview_mismatch" | "preview_changed" | "invalid_input";

export type OutboundResult<T> = ({ ok: true } & T) | { ok: false; reason: OutboundRefusal };

/** What was sent, for the host's log: never the code or the assertion. */
export interface OutboundSent {
  readonly act: "link" | "unlink";
  readonly targetOrigin: string;
  readonly httpStatus: number;
  readonly error: string | null;
}

export interface OrgOutbound {
  /** Ask the node named in `code` what the code is for: its org name and origin, so the admin can confirm before anything is signed. */
  preview(code: string): Promise<OutboundResult<{ preview: LinkPreview }>>;
  /** Sign `act: link` (after a fresh preview still names `expectOrgName`, with at least one service) or `act: unlink` for the org and node the code names, and post it once. */
  sign(input: {
    act: "link" | "unlink";
    code: string;
    services?: readonly string[] | undefined;
    expectOrgName?: string | undefined;
  }): Promise<OutboundResult<{ httpStatus: number; error: string | null; act: "link" | "unlink" | null }>>;
}

/** The short error code a node answers with, kept only when it looks like one (letters, digits and underscore). */
const SHORT_CODE = /^[a-z0-9_]{1,40}$/;

export function createOrgOutbound(deps: {
  http: OutboundHttp;
  getSigner: () => Promise<ServiceAssertionSigner | null>;
  onSent?: ((sent: OutboundSent) => void) | undefined;
}): OrgOutbound {
  /** The preview the node named in `parsed` gives for the code: its org name and its origin, which must be the origin the code names. */
  const fetchPreview = async (code: string, parsed: ParsedLinkCode): Promise<OutboundResult<{ preview: LinkPreview }>> => {
    let response: { status: number; body: string };
    try {
      // The code travels in the body, never in a URL (a URL is logged by every proxy on the way).
      response = await deps.http(`${parsed.origin}${LINK_PREVIEW_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (response.status === 404) return { ok: false, reason: "code_not_found" };
    if (response.status !== 200) return { ok: false, reason: "unreachable" };
    let body: { orgName?: unknown; origin?: unknown } = {};
    try {
      body = JSON.parse(response.body) as typeof body;
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (typeof body.orgName !== "string" || body.orgName.length === 0 || body.orgName.length > 200 || typeof body.origin !== "string") return { ok: false, reason: "preview_mismatch" };
    // The node that answered must be the node the code names.
    if (body.origin !== parsed.origin) return { ok: false, reason: "preview_mismatch" };
    return { ok: true, preview: { orgName: body.orgName, origin: body.origin } };
  };

  return {
    async preview(code) {
      const parsed = parseLinkCode(code);
      if (!parsed) return { ok: false, reason: "invalid_code" };
      return fetchPreview(code, parsed);
    },
    async sign(input) {
      const parsed = parseLinkCode(input.code);
      if (!parsed) return { ok: false, reason: "invalid_code" };
      if (input.act === "link") {
        if (!input.services || input.services.length === 0 || !input.expectOrgName) return { ok: false, reason: "invalid_input" };
        // The admin confirmed a name; sign only if the node that will receive the link still says that name for this code.
        const fresh = await fetchPreview(input.code, parsed);
        if (!fresh.ok) return fresh;
        if (fresh.preview.orgName !== input.expectOrgName) return { ok: false, reason: "preview_changed" };
      }
      const signer = await deps.getSigner();
      if (!signer) return { ok: false, reason: "no_signer" };
      let token: string;
      try {
        token = await signLinkAssertion(signer, {
          audienceNodeId: parsed.nodeId,
          act: input.act,
          orgUserId: parsed.orgUserId,
          ...(input.act === "link" ? { code: parsed.secret, ...(input.services ? { services: input.services } : {}) } : {}),
        });
      } catch {
        return { ok: false, reason: "invalid_input" };
      }
      let response: { status: number; body: string };
      try {
        response = await deps.http(`${parsed.origin}${LINK_PATH}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
      } catch {
        return { ok: false, reason: "unreachable" };
      }
      let body: { error?: unknown; act?: unknown } = {};
      try {
        body = JSON.parse(response.body) as typeof body;
      } catch {
        // A node that answers no JSON is reported by its status alone.
      }
      const error = typeof body.error === "string" && SHORT_CODE.test(body.error) ? body.error : null;
      const act = body.act === "link" || body.act === "unlink" ? body.act : null;
      deps.onSent?.({ act: input.act, targetOrigin: parsed.origin, httpStatus: response.status, error });
      return { ok: true, httpStatus: response.status, error, act };
    },
  };
}
