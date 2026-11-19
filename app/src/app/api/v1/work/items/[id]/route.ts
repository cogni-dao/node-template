// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for getting, patching, and deleting a single work item by ID.
 * Scope: Auth-protected GET (node-local Doltgres first, markdown fallback), PATCH (Doltgres only), and DELETE (retired, HTTP 410).
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTH_VIA_GETSESSIONUSER, PATCH_ALLOWLIST, DURABLE_IDENTITY_NEVER_REUSED.
 * Evaluation: shared score validation failures return HTTP400 with typed issues.
 * Write errors (task.0097, bug.0063): `handleWorkItemPatch` from @cogni/work-items parses, answers every write-contract error and
 *   returns the one terminal event; this route keeps only auth, the actor, 403, 404, node-admin and backend-unavailable.
 * Reason + cites (task.0086): a missing or over-cap reason is HTTP400 `invalid input` with an issue at `reason`; an unknown cite id or a closed inbox is HTTP400 `cite_unresolved`; cites with no resolver wired is HTTP400 `cites_unsupported`; a resolver failure is HTTP503. Nothing is written in each case.
 * Moves (story.0033): `set.moves` with an unknown or deprecated metric id is HTTP400 `cite_unresolved` with an issue at `set.moves`; a bad list is HTTP400 `invalid input`; a non-empty list with no metric wiring is HTTP400 `moves_unsupported`; a resolver failure is HTTP503 `cite_resolver_unavailable`; a baseline failure is HTTP503 `metric_baseline_unavailable`. The client never sets a baseline: the server pins it.
 * Envelope (task.0118): GET returns each `moves` entry with its metric, KPI and goal; `?include=links` adds the first page of citation links (same read as /api/v1/citations/{id}); an unknown include is HTTP400.
 * Side-effects: IO (HTTP response, filesystem read via port, Doltgres read/write/delete)
 * Links: contracts/work.items.{get,patch,delete}.v1.contract
 * @public
 */

import {
  workItemsDeleteOperation,
  workItemsGetOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { handleWorkItemPatch } from "@cogni/work-items";
import { NextResponse } from "next/server";

import {
  getWorkItem,
  NodeAdminRequiredError,
  patchWorkItem,
  WorkItemForbiddenError,
  WorkItemNotFoundError,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { routeAttribution } from "@/bootstrap/write-attribution";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/items/:id — Get a single work item by ID from node-local
 * Doltgres, falling back to the legacy markdown port when not imported.
 */
export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.get", auth: { mode: "required", getSessionUser } },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    // `?include=links,artifacts,history` (comma list) and `?artifact=<id>`: optional envelope parts. Unknown parts are a 400, not ignored.
    const params = new URL(request.url).searchParams;
    const requested = params
      .getAll("include")
      .flatMap((value) => value.split(","))
      .filter(Boolean);
    const artifact = params.get("artifact");
    const input = workItemsGetOperation.input.safeParse({
      id,
      ...(requested.length && { include: requested }),
      ...(artifact !== null && { artifact }),
    });
    if (!input.success) {
      return NextResponse.json(
        { error: "invalid input", issues: input.error.issues },
        { status: 400 }
      );
    }

    let item: Awaited<ReturnType<typeof getWorkItem>>;
    try {
      item = await getWorkItem(id, {
        signal: request.signal,
        includeLinks: input.data.include?.includes("links") ?? false,
        includeArtifacts: input.data.include?.includes("artifacts") ?? false,
        includeHistory: input.data.include?.includes("history") ?? false,
        ...(input.data.artifact !== undefined && { artifactId: input.data.artifact }),
      });
    } catch (e) {
      if (e instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: e.message }, { status: 503 });
      }
      throw e;
    }

    if (!item) {
      return NextResponse.json(
        { error: `Work item not found: ${id}` },
        { status: 404 }
      );
    }

    ctx.log.info({ workItemId: id }, "work.items.get_success");

    return NextResponse.json(workItemsGetOperation.output.parse(item));
  }
);

/**
 * PATCH /api/v1/work/items/:id — Patch a work item (Doltgres only).
 *
 * Authorization is the same-door `authorize()` check (scope `work_item:transition`)
 * run by the route wrapper; the creator stamped at insert is attribution, never a gate
 * (bug.0019). The path id remains authoritative over request data.
 */
export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.patch",
    sameDoor: "core__work_item_update",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    // The package owns parse, refusals and the one terminal event (bug.0063); this route keeps auth, the actor and node errors.
    const attribution = routeAttribution(sessionUser.id);
    const result = await handleWorkItemPatch(id, {
      readJson: () => request.json(),
      parse: (body) => workItemsPatchOperation.input.safeParse(body),
      write: (input) => patchWorkItem(input, { id: sessionUser.id }, attribution),
      attribution,
      toBody: (patched) => workItemsPatchOperation.output.parse(patched),
      mapNodeError: (e) => {
        if (e instanceof WorkItemNotFoundError) return { status: 404, errorCode: "not_found", body: { error: e.message } };
        if (e instanceof WorkItemForbiddenError) return { status: 403, errorCode: "forbidden", body: { error: e.message } };
        if (e instanceof NodeAdminRequiredError)
          return { status: e.status, errorCode: e.errorCode, body: { error: e.message, errorCode: e.errorCode, action: e.action } };
        if (e instanceof WorkItemsBackendNotReadyError)
          return { status: 503, errorCode: "backend_unavailable", body: { error: e.message } };
        return undefined;
      },
    });
    ctx.log.info(result.event, result.event.event);
    return NextResponse.json(result.body, { status: result.status });
  }
);

/** Retired hard-delete: preserve versioned identity and provenance. */
export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.delete", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const parsed = workItemsDeleteOperation.input.safeParse({ id });
    if (!parsed.success)
      return NextResponse.json({ error: "invalid input" }, { status: 400 });
    return NextResponse.json(
      workItemsDeleteOperation.output.parse({
        error: "work_item_deletion_retired",
        message:
          "PATCH status=cancelled to preserve work-item identity and provenance",
      }),
      { status: 410 }
    );
  }
);
