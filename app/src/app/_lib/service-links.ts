// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Thin plane-specific mounts of shared service-link operations. Each plane uses its own authenticator and the same authority. */
import { createServiceLinkHandlers } from "@cogni/agent-grants/enrollment-requester";
import { NextResponse } from "next/server";
import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { resolveRequestIdentity } from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
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
/**
 * The doors of the four service-link routes, declared once (admin subject; a bearer also needs its role row). Both planes mount the same four.
 * The route id comes first in `serviceLinkRoute` so the route enumeration test reads it (bearer-write-deny-by-default).
 */
const SERVICE_LINK_ROUTES = {
  "service.links.create": { routeId: "service.links.create", sameDoor: "service-link.manage" },
  "service.links.read": { routeId: "service.links.read", sameDoor: "service-link.manage" },
  "service.links.knowledge": { routeId: "service.links.knowledge", sameDoor: "service-link.manage" },
  "service.links.disconnect": { routeId: "service.links.disconnect", sameDoor: "service-link.manage" },
} as const;
type ServiceLinkRouteId = keyof typeof SERVICE_LINK_ROUTES;

export function serviceLinkRoute(routeId: ServiceLinkRouteId, plane: "human" | "ai") {
  const action = routeId.slice("service.links.".length) as "create" | "read" | "knowledge" | "disconnect";
  const config = SERVICE_LINK_ROUTES[routeId];
  // An authenticated admin route: the normal wrapper resolves the caller, runs the declared door (a human passes the admin check; a bearer needs its
  // role row AND the same admin check) and logs; it is not a public route. The human plane reads the cookie session only.
  return wrapRouteHandlerWithLogging<{
    params: Promise<{ linkId: string; entryId?: string }>;
  }>(
    {
      routeId: config.routeId,
      sameDoor: config.sameDoor,
      auth: { mode: "required", getSessionUser: plane === "human" ? getServerSessionUser : resolveRequestIdentity },
    },
    async (ctx, request, subject, context) => {
    if (plane === "human") {
      const refusal = refuseNonSession(request, ctx.log);
      if (refusal) return refusal;
      const origin = request.headers.get("origin");
      if (origin && origin !== serviceHomeTuple().origin)
        return json({ error: "human_session_required" }, 403);
    } else if (!request.headers.get("authorization")?.startsWith("Bearer "))
      return json({ error: "not_found" }, 404);
    try {
      if (plane === "ai" && subject.via !== "bearer") return json({ error: "not_found" }, 404);
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
    }
  );
}
