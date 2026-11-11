// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/citation-links`
 * Purpose: Helps a reviewer decide whether an entry's or inbox's links are complete
 *   and correct. Each edge is one row: direction arrow, relation, slug. Shared by
 *   an entry's Links section and the inbox citation diff.
 * Scope: Presentation over injected data. The node owns transport, hrefs and its router link.
 * Invariants: SLUG_NOT_TITLE (titles only on hover), DIRECTION_VISIBLE, EVERY_DIFF_EDGE_LISTED.
 * Side-effects: IO (injected page loader, CitationLinks only)
 * @public
 */

import type { ComponentType, ReactElement, ReactNode } from "react";

import { cn } from "./cn.js";
import {
  DirectRelationLinks,
  type DirectRelationPage,
} from "./direct-relation-links.js";

/** Only what the rows pass, so `next/link` and a plain anchor both fit. */
export interface CitationLinkProps {
  readonly href: string;
  readonly title?: string;
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
}
/** A router link (for example `next/link`) or the default anchor. */
export type CitationLinkComponent = ComponentType<CitationLinkProps>;

const DefaultLink: CitationLinkComponent = (props) => <a {...props} />;

export interface CitationLinkEndpoint {
  readonly id: string;
  readonly title?: string | null;
  readonly href: string;
}

/** One depth-1 edge as `GET /api/v1/citations/{id}` serves it. */
export interface CitationLink {
  readonly id: string;
  readonly direction: "out" | "in";
  readonly citationType: string;
  readonly source: CitationLinkEndpoint;
  readonly target: CitationLinkEndpoint;
  readonly context?: string | null;
}

/** One edge a contribution changes, as the contribution diff serves it. */
export interface CitationDiffEdge {
  readonly changeType: "added" | "modified" | "removed";
  readonly citingId: string;
  readonly citedId: string;
  readonly citationType: string;
  readonly context?: string | null;
}

const ARROW = {
  out: { glyph: "→", label: "outgoing" },
  in: { glyph: "←", label: "incoming" },
} as const;

const CHANGE = {
  added: { glyph: "+", label: "added", className: "text-success" },
  removed: { glyph: "−", label: "removed", className: "text-destructive" },
  modified: { glyph: "~", label: "changed", className: "text-warning" },
} as const;

/**
 * One edge, one interactive surface: the whole row is the link (≥24px tall,
 * visible focus). Reads as marker, arrow, relation, slug; the title or edge
 * context is the hover text only.
 */
function CitationRow({
  direction,
  relation,
  slug,
  href,
  hoverTitle,
  change,
  Link,
}: {
  readonly direction: "out" | "in";
  readonly relation: string;
  readonly slug: string;
  readonly href: string;
  readonly hoverTitle?: string | null | undefined;
  readonly change?: CitationDiffEdge["changeType"];
  readonly Link: CitationLinkComponent;
}): ReactElement {
  const arrow = ARROW[direction];
  const marker = change ? CHANGE[change] : null;
  return (
    <Link
      href={href}
      title={hoverTitle?.trim() || slug}
      aria-label={[marker?.label, arrow.label, relation, slug]
        .filter(Boolean)
        .join(" ")}
      className="-mx-1 flex min-h-6 min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      {marker && (
        <span className={cn("w-3 shrink-0 text-center", marker.className)}>
          {marker.glyph}
        </span>
      )}
      <span className="w-3 shrink-0 text-center text-muted-foreground">
        {arrow.glyph}
      </span>
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          change === "removed" && "line-through decoration-destructive/60"
        )}
      >
        <span className="w-24 shrink-0 truncate text-muted-foreground">
          {relation}
        </span>
        <span className="min-w-0 break-all font-mono">{slug}</span>
      </span>
    </Link>
  );
}

export interface CitationLinksProps {
  readonly entityId: string;
  /** Keep this callback stable. The node retains its authenticated transport. */
  readonly loadPage: (
    entityId: string,
    cursor?: string
  ) => Promise<DirectRelationPage<CitationLink>>;
  readonly LinkComponent?: CitationLinkComponent;
  readonly className?: string;
}

/**
 * An entry's Links section: one row per edge (arrow, relation, slug), with
 * bounded paging from DirectRelationLinks. The title shows only on hover.
 */
export function CitationLinks({
  entityId,
  loadPage,
  LinkComponent = DefaultLink,
  className,
}: CitationLinksProps): ReactElement | null {
  return (
    <DirectRelationLinks
      entityId={entityId}
      loadPage={loadPage}
      className={cn("flex flex-col gap-1", className)}
      headingClassName="font-medium text-muted-foreground text-xs uppercase tracking-wider"
      linksClassName="flex flex-col gap-0.5"
      moreButtonClassName="w-fit rounded border px-2 py-1 text-xs disabled:opacity-50"
      renderLink={(link) => {
        const other = link.direction === "out" ? link.target : link.source;
        return (
          <CitationRow
            direction={link.direction}
            relation={link.citationType}
            slug={other.id}
            href={other.href}
            hoverTitle={other.title}
            Link={LinkComponent}
          />
        );
      }}
    />
  );
}

/** The diff-row fields the grouping reads; the node's diff entry satisfies it. */
export interface ContributionDiffRowLike {
  readonly changeType: "added" | "modified" | "removed";
  readonly rowId: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly changedFields?: readonly string[] | undefined;
}

/** Everything one inbox changes about one entry, so each entry appears once. */
export interface ContributionEntryChange<E extends ContributionDiffRowLike> {
  readonly rowId: string;
  /** The row diff, when the entry's row changed at all. */
  readonly entry: E | null;
  /** True when a field other than confidence changed (or the row was added/removed). */
  readonly authored: boolean;
  /** Before and after confidence, when it changed. */
  readonly confidence: { readonly from: unknown; readonly to: unknown } | null;
  /** Link changes this entry makes (it is the citing side). */
  readonly edges: readonly CitationDiffEdge[];
}

/**
 * Fold row changes and link changes into one record per entry. An edge belongs
 * to its citing entry, so every edge appears exactly once. Order: authored
 * changes (diff order), then entries that only change links, then entries whose
 * only change is confidence. A modified row without `changedFields` counts as
 * authored, so an older server never hides an edit.
 */
export function groupContributionChanges<E extends ContributionDiffRowLike>(
  entries: readonly E[],
  citations: readonly CitationDiffEdge[]
): ContributionEntryChange<E>[] {
  const edgesBy = new Map<string, CitationDiffEdge[]>();
  for (const edge of citations) {
    const list = edgesBy.get(edge.citingId);
    if (list) list.push(edge);
    else edgesBy.set(edge.citingId, [edge]);
  }
  const changes: ContributionEntryChange<E>[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    seen.add(entry.rowId);
    const fields = entry.changedFields;
    const confidenceChanged =
      entry.changeType === "modified" &&
      (fields?.includes("confidencePct") ?? false);
    changes.push({
      rowId: entry.rowId,
      entry,
      authored:
        entry.changeType !== "modified" ||
        !fields ||
        fields.some((field) => field !== "confidencePct"),
      confidence: confidenceChanged
        ? { from: entry.before?.confidencePct, to: entry.after?.confidencePct }
        : null,
      edges: edgesBy.get(entry.rowId) ?? [],
    });
  }
  for (const [rowId, edges] of edgesBy) {
    if (seen.has(rowId)) continue;
    changes.push({ rowId, entry: null, authored: false, confidence: null, edges });
  }
  const rank = (change: ContributionEntryChange<E>) =>
    change.authored ? 0 : change.edges.length > 0 ? 1 : 2;
  return changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => rank(a.change) - rank(b.change) || a.index - b.index)
    .map(({ change }) => change);
}

export interface CitationEdgeListProps {
  /** The link changes one entry makes, from `groupContributionChanges`. */
  readonly edges: readonly CitationDiffEdge[];
  /** Permalink for an entry or work-item id; the node owns routing. */
  readonly hrefFor: (id: string) => string;
  readonly LinkComponent?: CitationLinkComponent;
  readonly className?: string;
}

/**
 * One entry's link changes inside its inbox card: marker, arrow, relation and
 * the cited slug per row, in the same form as an entry's Links section.
 */
export function CitationEdgeList({
  edges,
  hrefFor,
  LinkComponent = DefaultLink,
  className,
}: CitationEdgeListProps): ReactElement | null {
  if (edges.length === 0) return null;
  return (
    <ul aria-label="Link changes" className={cn("flex flex-col", className)}>
      {edges.map((edge) => (
        <li key={`${edge.changeType}:${edge.citationType}:${edge.citedId}`}>
          <CitationRow
            direction="out"
            relation={edge.citationType}
            slug={edge.citedId}
            href={hrefFor(edge.citedId)}
            hoverTitle={edge.context}
            change={edge.changeType}
            Link={LinkComponent}
          />
        </li>
      ))}
    </ul>
  );
}
