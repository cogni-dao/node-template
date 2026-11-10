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

export interface ContributionCitationDiffProps {
  readonly citations: readonly CitationDiffEdge[];
  /** Permalink for an entry or work-item id; the node owns routing. */
  readonly hrefFor: (id: string) => string;
  readonly LinkComponent?: CitationLinkComponent;
  readonly className?: string;
}

/**
 * Every citation edge an inbox changes, grouped under its citing entry, each
 * row in the same arrow, relation, slug form as an entry's Links section.
 */
export function ContributionCitationDiff({
  citations,
  hrefFor,
  LinkComponent = DefaultLink,
  className,
}: ContributionCitationDiffProps): ReactElement | null {
  if (citations.length === 0) return null;
  const groups = new Map<string, CitationDiffEdge[]>();
  for (const edge of citations) {
    const group = groups.get(edge.citingId);
    if (group) group.push(edge);
    else groups.set(edge.citingId, [edge]);
  }

  return (
    <section
      aria-label="Link changes"
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2",
        className
      )}
    >
      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
        Links ({citations.length})
      </span>
      {[...groups].map(([citingId, edges]) => (
        <div key={citingId} className="flex flex-col gap-0.5">
          <LinkComponent
            href={hrefFor(citingId)}
            className="-mx-1 flex min-h-6 w-fit items-center rounded-sm px-1 font-mono text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            {citingId}
          </LinkComponent>
          <ul className="flex flex-col gap-0.5 pl-3">
            {edges.map((edge) => (
              <li
                key={`${edge.changeType}:${edge.citationType}:${edge.citedId}`}
              >
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
        </div>
      ))}
    </section>
  );
}
