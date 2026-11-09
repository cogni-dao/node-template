// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/graph/route`
 * Purpose: GET /api/v1/knowledge/graph — the whole knowledge graph: every entry
 *   (projected: id, domain, title, entryType, confidencePct, sourceType) and every
 *   citation between entries, at one store revision.
 * Scope: Any authenticated principal (cookie-session human OR bearer agent), like /knowledge.
 * Invariants: VALIDATE_IO (`KnowledgeGraphResponseSchema`), AUTH_VIA_GETSESSIONUSER,
 *   KNOWLEDGE_READ_REQUIRES_PRINCIPAL, EDGE_ENDPOINTS_EXIST,
 *   WHOLE_CORPUS (never truncated: the payload carries exact node and edge counts),
 *   ONE_READ_PER_REVISION (one projected node read + one citation read per Dolt HEAD),
 *   REVALIDATE_BY_REVISION (ETag = the Dolt HEAD; If-None-Match on an unchanged
 *   revision returns 304 with no body and no graph read; `Cache-Control: private,
 *   no-cache, must-revalidate` so browsers always revalidate and never share it).
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: docs/spec/knowledge-syntropy.md, task.0059
 * @public
 */

import { NextResponse } from "next/server";
import { loadKnowledgeGraphBody } from "@/app/(app)/knowledge/_server/loaders";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_CONTROL = "private, no-cache, must-revalidate";

/** True when an If-None-Match header names this entity tag (or `*`). */
function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.graph",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const port = getContainer().knowledgeStorePort;
    if (!port) {
      return NextResponse.json(
        { error: "knowledge store not configured" },
        { status: 503 }
      );
    }

    const revision = await port.currentCommit();
    const etag = `"${revision}"`;
    const headers = { ETag: etag, "Cache-Control": CACHE_CONTROL };
    if (matches(request.headers.get("if-none-match"), etag)) {
      ctx.log.info({ revision, notModified: true }, "knowledge.graph_success");
      return new NextResponse(null, { status: 304, headers });
    }

    const { graph, body } = await loadKnowledgeGraphBody(port, revision);
    ctx.log.info(
      {
        revision,
        notModified: false,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        domains: graph.domains.length,
        bytes: Buffer.byteLength(body),
      },
      "knowledge.graph_success"
    );
    return new NextResponse(body, {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
);
