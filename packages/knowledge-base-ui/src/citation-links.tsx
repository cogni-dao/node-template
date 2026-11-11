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
  /** The linked entry or work-item id, so a host link can open it in place (for example a side sheet). */
  readonly entityId?: string;
  readonly children?: ReactNode;
}
/** A router link (for example `next/link`) or the default anchor. */
export type CitationLinkComponent = ComponentType<CitationLinkProps>;

const DefaultLink: CitationLinkComponent = ({ entityId: _entityId, ...props }) => (
  <a {...props} />
);

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
  /** This side's reading from the store's citation definitions ("supported by"). */
  readonly label?: string;
  readonly tone?: CitationTone;
}

/** Visual weight a citation definition assigns; rows map it to theme tokens. */
export type CitationTone = "positive" | "negative" | "warning" | "neutral" | "muted";

/** One edge a contribution changes, as the contribution diff serves it. */
export interface CitationDiffEdge {
  readonly changeType: "added" | "modified" | "removed";
  readonly citingId: string;
  readonly citedId: string;
  readonly citationType: string;
  readonly context?: string | null;
  /** The citing side's reading from the store's citation definitions. */
  readonly label?: string;
  readonly tone?: CitationTone;
}

const TONE_CLASS: Record<CitationTone, string> = {
  positive: "bg-success/15 text-success",
  negative: "bg-destructive/15 text-destructive",
  warning: "bg-warning/15 text-warning",
  neutral: "bg-primary/15 text-primary",
  muted: "bg-muted text-muted-foreground",
};

const ARROW = {
  out: { glyph: "→", label: "outgoing" },
  in: { glyph: "←", label: "incoming" },
} as const;

/**
 * One edge, one interactive surface: the whole row is the link (≥32px tall,
 * visible focus). Reads as arrow, relation, slug; the title or edge
 * context is the hover text only.
 */
function CitationRow({
  direction,
  relation,
  tone = "muted",
  slug,
  href,
  hoverTitle,
  Link,
}: {
  readonly direction: "out" | "in";
  /** The definition's label for this side; the raw type only from an older server. */
  readonly relation: string;
  readonly tone?: CitationTone | undefined;
  readonly slug: string;
  readonly href: string;
  readonly hoverTitle?: string | null | undefined;
  readonly Link: CitationLinkComponent;
}): ReactElement {
  const arrow = ARROW[direction];
  return (
    <Link
      href={href}
      entityId={slug}
      title={hoverTitle?.trim() || slug}
      aria-label={`${arrow.label} ${relation} ${slug}`}
      className="-mx-1.5 flex min-h-8 min-w-0 items-center gap-2 rounded-md px-1.5 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="w-3 shrink-0 text-center text-muted-foreground text-sm">
        {arrow.glyph}
      </span>
      <span
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1"
      >
        <span className="min-w-28 shrink-0">
          <span
            className={cn(
              "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-xs",
              TONE_CLASS[tone]
            )}
          >
            {relation}
          </span>
        </span>
        <span className="min-w-0 break-all font-medium font-mono text-foreground text-sm">
          {slug}
        </span>
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
      className={cn("flex flex-col gap-1.5", className)}
      headingClassName="font-medium text-muted-foreground text-xs uppercase tracking-wider"
      linksClassName="flex flex-col rounded-lg border border-border bg-card px-2 py-1.5 empty:hidden"
      moreButtonClassName="w-fit rounded border px-2 py-1 text-xs disabled:opacity-50"
      renderLink={(link) => {
        const other = link.direction === "out" ? link.target : link.source;
        return (
          <CitationRow
            direction={link.direction}
            relation={link.label ?? link.citationType}
            tone={link.tone}
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
        fields.length === 0 ||
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
  /** The citing entry, so each card's list has its own accessible name. */
  readonly entryId?: string;
  /** Permalink for an entry or work-item id; the node owns routing. */
  readonly hrefFor: (id: string) => string;
  readonly LinkComponent?: CitationLinkComponent;
  readonly className?: string;
}

/**
 * One entry's link changes inside its inbox card, one sentence per edge: badge,
 * the cited slug per row, in the same form as an entry's Links section.
 */
const LINK_BADGE = {
  added: { text: "link +", label: "added", className: "bg-success/15 text-success" },
  removed: { text: "link −", label: "removed", className: "bg-destructive/15 text-destructive" },
  modified: { text: "link ~", label: "changed", className: "bg-warning/15 text-warning" },
} as const;

/**
 * One changed edge as a readable sentence: badge, citing slug, relation,
 * arrow, cited slug ("link + a-entry extends → b-entry"). The whole row opens
 * the cited entry; the edge context is the hover text.
 */
function CitationDiffRow({
  edge,
  href,
  Link,
}: {
  readonly edge: CitationDiffEdge;
  readonly href: string;
  readonly Link: CitationLinkComponent;
}): ReactElement {
  const badge = LINK_BADGE[edge.changeType];
  const relation = edge.label ?? edge.citationType;
  return (
    <Link
      href={href}
      entityId={edge.citedId}
      title={edge.context?.trim() || edge.citedId}
      aria-label={`${badge.label} link: ${edge.citingId} ${relation} ${edge.citedId}`}
      className="-mx-1.5 flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={cn(
          "inline-flex shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider",
          badge.className
        )}
      >
        {badge.text}
      </span>
      <span
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm",
          edge.changeType === "removed" && "line-through decoration-destructive/60"
        )}
      >
        <span className="break-all text-muted-foreground">{edge.citingId}</span>
        <span
          className={cn(
            "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 font-medium font-sans text-xs",
            TONE_CLASS[edge.tone ?? "muted"]
          )}
        >
          {relation}
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="break-all font-medium text-foreground">
          {edge.citedId}
        </span>
      </span>
    </Link>
  );
}

export function CitationEdgeList({
  edges,
  entryId,
  hrefFor,
  LinkComponent = DefaultLink,
  className,
}: CitationEdgeListProps): ReactElement | null {
  if (edges.length === 0) return null;
  return (
    <ul
      aria-label={entryId ? `Link changes for ${entryId}` : "Link changes"}
      className={cn("flex flex-col", className)}
    >
      {edges.map((edge) => (
        <li key={`${edge.changeType}:${edge.citationType}:${edge.citedId}`}>
          <CitationDiffRow
            edge={edge}
            href={hrefFor(edge.citedId)}
            Link={LinkComponent}
          />
        </li>
      ))}
    </ul>
  );
}
