// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for getting, patching, and deleting a single work item by ID.
 * Scope: Auth-protected GET (node-local Doltgres first, markdown fallback), PATCH (Doltgres only), and DELETE (retired, HTTP 410).
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, AUTH_VIA_GETSESSIONUSER, PATCH_ALLOWLIST, DURABLE_IDENTITY_NEVER_REUSED.
 * Evaluation: shared score validation failures return HTTP400 with typed issues.
 * Write errors (task.0097): `workItemWriteErrorResponse` from @cogni/work-items answers every write-contract error below; this route keeps only auth, 403, 404, node-admin and backend-unavailable.
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
import { workItemWriteErrorResponse } from "@cogni/work-items";
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

    // `?include=links` (comma list): optional envelope parts. Unknown parts are a 400, not ignored.
    const requested = new URL(request.url).searchParams
      .getAll("include")
      .flatMap((value) => value.split(","))
      .filter(Boolean);
    const input = workItemsGetOperation.input.safeParse({
      id,
      ...(requested.length && { include: requested }),
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
    // Every refusal ends in ONE registered terminal event with its errorCode (task.0122): ids and codes, never the body.
    const refuse = (
      status: number,
      errorCode: string,
      body: unknown,
      extra: Record<string, string> = {}
    ): NextResponse => {
      ctx.log.info(
        {
          event: EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED,
          routeId: "work.items.patch",
          outcome: "refused",
          workItemId: id,
          status,
          errorCode,
          ...extra,
        },
        EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED
      );
      return NextResponse.json(body, { status });
    };

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return refuse(400, "invalid_json", { error: "invalid JSON body" });
    }

    if (
      typeof body === "object" &&
      body !== null &&
      "id" in body &&
      body.id !== undefined &&
      body.id !== id
    ) {
      return refuse(400, "id_mismatch", { error: "body id must match path id" });
    }

    const parseResult = workItemsPatchOperation.input.safeParse({
      ...(typeof body === "object" && body !== null ? body : {}),
      id,
    });
    if (!parseResult.success) {
      return refuse(400, "invalid_input", {
        error: "invalid input",
        issues: parseResult.error.issues,
      });
    }

    try {
      const patched = await patchWorkItem(parseResult.data, {
        id: sessionUser.id,
        walletAddress: sessionUser.walletAddress,
      });
      ctx.log.info(
        {
          event: EVENT_NAMES.WORK_ITEMS_PATCH_SUCCESS,
          routeId: "work.items.patch",
          outcome: "success",
          status: 200,
          workItemId: id,
          citeCount: parseResult.data.cites?.length ?? 0,
        },
        EVENT_NAMES.WORK_ITEMS_PATCH_SUCCESS
      );
      return NextResponse.json(workItemsPatchOperation.output.parse(patched));
    } catch (e) {
      // The package owns every write-contract answer (scores, reason, cites, moves, revision
      // conflict, write outcome unknown, resolver and baseline failures) and matches by name.
      const mapped = workItemWriteErrorResponse(e, "patch");
      if (mapped) {
        // What the gate found: the stage move and the missing artifact or fact, never a body.
        const { from, to, missing } = mapped.body as {
          from?: unknown;
          to?: unknown;
          missing?: unknown;
        };
        return refuse(mapped.status, mapped.errorCode, mapped.body, {
          ...(typeof from === "string" ? { from } : {}),
          ...(typeof to === "string" ? { to } : {}),
          ...(typeof missing === "string" ? { missing } : {}),
        });
      }
      if (e instanceof WorkItemNotFoundError) {
        return refuse(404, "not_found", { error: e.message });
      }
      if (e instanceof WorkItemForbiddenError) {
        return refuse(403, "forbidden", { error: e.message });
      }
      if (e instanceof NodeAdminRequiredError) {
        return refuse(e.status, e.errorCode, {
          error: e.message,
          errorCode: e.errorCode,
          action: e.action,
        });
      }
      if (e instanceof WorkItemsBackendNotReadyError) {
        return refuse(503, "backend_unavailable", { error: e.message });
      }
      throw e;
    }
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
