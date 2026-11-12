// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/citation-links`
 * Purpose: The ONE read of an endpoint's depth-1 citation links, shared by `GET /api/v1/citations/{id}`
 *   (the UI's EntityCitationLinks), the work item route's `?include=links` and core__work_item_read.
 * Scope: Maps one `listCitationLinks` page to the wire shape. No writes, no endpoint body reads.
 * Invariants:
 *   - ONE_LINKS_READ (task.0118): every consumer reads links through `readCitationLinksPage`, so the
 *     UI and agents see the same edges, labels and tones.
 *   - LINKS_BOUNDED: one page of at most five links plus `nextCursor`; the caller pages on.
 *   - LINKS_UNAVAILABLE_NOT_EMPTY: `readItemLinks` reports a failed or absent store as `unavailable`,
 *     never as an empty list.
 * Side-effects: IO (knowledge store read)
 * Links: app/src/app/api/v1/citations/[id]/route.ts, docs/spec/knowledge-syntropy.md
 * @internal
 */

import { describeCitation, isWorkItemEndpointId } from "@cogni/knowledge-store";
import type { KnowledgeStorePort } from "@cogni/knowledge-store";
import {
  CitationLinksPageSchema,
  type WorkItemLinks,
} from "@cogni/work-items";

/** Canonical human URL for a node-local work item. */
export function workItemPermalink(id: string): string {
  return `/work/items/${encodeURIComponent(id)}`;
}

function endpoint(id: string, title: string | null) {
  const isWork = isWorkItemEndpointId(id);
  return {
    id,
    kind: isWork ? ("work" as const) : ("knowledge" as const),
    title,
    href: isWork ? workItemPermalink(id) : `/knowledge/${encodeURIComponent(id)}`,
  };
}

/** One page of links for `id`, validated against the wire schema. */
export async function readCitationLinksPage(
  port: Pick<KnowledgeStorePort, "listCitationLinks">,
  id: string,
  cursor?: string,
) {
  const page = await port.listCitationLinks(id, cursor);
  const links = page.links.map((c) => {
    const direction = c.citingId === id ? ("out" as const) : ("in" as const);
    return {
      id: c.id,
      direction,
      citationType: c.citationType,
      source: endpoint(c.citingId, c.sourceTitle),
      target: endpoint(c.citedId, c.targetTitle),
      context: c.context,
      ...describeCitation(c.citationType, direction),
    };
  });
  return CitationLinksPageSchema.parse({ links, nextCursor: page.nextCursor });
}

/** The item envelope's `links`: the first page, or `unavailable` when it could not be read. */
export async function readItemLinks(
  port: Pick<KnowledgeStorePort, "listCitationLinks"> | undefined,
  id: string,
): Promise<WorkItemLinks> {
  if (!port) return { items: [], nextCursor: null, unavailable: true };
  try {
    const page = await readCitationLinksPage(port, id);
    return { items: page.links, nextCursor: page.nextCursor };
  } catch {
    return { items: [], nextCursor: null, unavailable: true };
  }
}
