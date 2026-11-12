// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Thin plane-specific mounts of shared service-link operations. Each plane uses its own authenticator and the same authority. */
import { createServiceLinkHandlers } from "@cogni/agent-grants/enrollment-requester";
import { NextResponse } from "next/server";
import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { resolveRequestIdentity } from "@/app/_lib/auth/request-identity";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";
import { TokenBucketRateLimiter } from "@/bootstrap/http/rateLimiter";
import {
  getServiceLinks,
  serviceConnectionKey,
  serviceHomeTuple,
  serviceLinkHandle,
} from "@/bootstrap/service-links";
import { getServerSessionUser } from "@/lib/auth/server";

const startLimiter = new TokenBucketRateLimiter({
  maxTokens: 5,
  refillRate: 5 / 3600,
  burstSize: 0,
  maxKeys: 10000,
});
const json = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
export function serviceLinkRoute(
  plane: "human" | "ai",
  action: "create" | "read" | "knowledge" | "disconnect"
) {
  return wrapPublicRoute<{
    params: Promise<{ linkId: string; entryId?: string }>;
  }>({ routeId: `service.links.${action}` }, async (ctx, request, context) => {
    if (plane === "human") {
      const refusal = refuseNonSession(request, ctx.log);
      if (refusal) return refusal;
      const origin = request.headers.get("origin");
      if (origin && origin !== serviceHomeTuple().origin)
        return json({ error: "human_session_required" }, 403);
    } else if (!request.headers.get("authorization")?.startsWith("Bearer "))
      return json({ error: "not_found" }, 404);
    try {
      const subject =
        plane === "human"
          ? await getServerSessionUser()
          : await resolveRequestIdentity();
      if (!subject || (plane === "ai" && subject.via !== "bearer"))
        return json(
          { error: plane === "ai" ? "not_found" : "unauthorized" },
          plane === "ai" ? 404 : 401
        );
      // Shared NodeAdminAuthority; a credential supplies identity only, never session fallback or self approval.
      const authority = getContainer().agentAuthority;
      const admin = await authority.adminCheck(subject.id);
      if (admin !== "allow")
        return json(
          {
            error:
              admin === "unavailable" ? "authz_unavailable" : "authz_denied",
          },
          admin === "unavailable" ? 503 : 403
        );
      if (action === "create" && !startLimiter.consume(subject.id))
        return json({ error: "rate_limited" }, 429);
      const shared = createServiceLinkHandlers({
        ...(await getServiceLinks()),
        keyForAlias: serviceConnectionKey,
        handleForId: serviceLinkHandle,
        allowedEntries: ["operator-architect", "index"],
      });
      const params = context
        ? await (
            context as { params: Promise<{ linkId: string; entryId?: string }> }
          ).params
        : undefined;
      const result =
        action === "create"
          ? await shared.create(await request.json().catch(() => undefined))
          : action === "read"
            ? await shared.read(
                params?.linkId ?? "",
                new URL(request.url).searchParams.has("resumeRevision")
                  ? Number(
                      new URL(request.url).searchParams.get("resumeRevision")
                    )
                  : undefined
              )
            : action === "knowledge"
              ? await shared.knowledge(
                  params?.linkId ?? "",
                  params?.entryId ?? ""
                )
              : await shared.disconnect(
                  params?.linkId ?? "",
                  await request.json().catch(() => undefined)
                );
      ctx.log.info(
        {
          event: "service.link.operation",
          action,
          plane,
          status: result.status,
          linkId: params?.linkId,
        },
        "service.link.operation"
      );
      return NextResponse.json(result.body, {
        status: result.status,
        headers: result.headers,
      });
    } catch {
      ctx.log.warn(
        { event: "service.link.unavailable", action, plane },
        "service.link.unavailable"
      );
      return json({ error: "service_unavailable" }, 503);
    }
  });
}
