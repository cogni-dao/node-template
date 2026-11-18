// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-design-links`
 * Purpose: Helps a human see what plan and design a work item is built on, and open either in one click (story.0069).
 * Scope: Presentation. The Design section lists the goal roadmaps that track the item (a roadmap atom's `tracks` edge to it) and the
 *   item's `specRefs` design atoms. Each is one `CitationRow` with its own icon: a map for a roadmap, a drafting compass for a design.
 *   An entry written before the type stays one plain text line. No fetch: the host passes the refs it already read.
 * Invariants:
 *   - ONE_ROW_RENDERER: rows are `CitationRow` in `CITATION_LIST_CLASS`; no bespoke layout.
 *   - ONE_SPEC_REF_TYPE: the package's `parseSpecRef` decides what is a design link; no second pattern here.
 *   - ONE_EMPTY_STATE: nothing linked draws the heading and one muted line, as every work-item section does.
 *   - ROADMAP_FIRST: the roadmap (why this item, in what order) comes before the designs (how it is built).
 * Side-effects: none
 * Links: hub work-item-design-links, ./citation-links.tsx, ./work-pull-links.tsx
 * @public
 */

import { parseSpecRef } from "@cogni/work-items";
import { DraftingCompass, Map as MapIcon } from "lucide-react";
import type { ReactElement } from "react";

import {
  CITATION_HEADING_CLASS,
  CITATION_LIST_CLASS,
  type CitationLinkComponent,
  CitationRow,
  DefaultCitationLink,
} from "./citation-links.js";
import { WORK_SECTION_EMPTY_CLASS } from "./work-pull-links.js";

/** An atom's page on a node that mounts the Knowledge pages at `/knowledge`. */
export const defaultDesignHref = (atomId: string): string => `/knowledge/${encodeURIComponent(atomId)}`;

export function WorkDesignLinks({
  specRefs,
  roadmapIds = [],
  hrefFor = defaultDesignHref,
  LinkComponent = DefaultCitationLink,
}: {
  readonly specRefs: readonly string[];
  /** Roadmap atoms that track this item: the sources of its incoming `tracks` edges. */
  readonly roadmapIds?: readonly string[];
  /** The node's page for one atom id. Default `/knowledge/{id}`. */
  readonly hrefFor?: (atomId: string) => string;
  /** The node's link (for example one that peeks an entry in a side sheet). Default `<a>`. */
  readonly LinkComponent?: CitationLinkComponent;
}): ReactElement {
  const roadmaps = [...new Set(roadmapIds)];
  return (
    <section aria-label="Design" data-work-design="links" className="flex flex-col gap-1.5">
      <h3 className={CITATION_HEADING_CLASS}>Design</h3>
      {roadmaps.length === 0 && specRefs.length === 0 ? (
        <span className={WORK_SECTION_EMPTY_CLASS}>No design linked yet</span>
      ) : (
        <div className={CITATION_LIST_CLASS}>
          {roadmaps.map((id) => (
            <CitationRow
              key={`roadmap:${id}`}
              direction="in"
              relation="roadmap"
              tone="neutral"
              slug={id}
              href={hrefFor(id)}
              icon={<MapIcon className="size-3.5" />}
              Link={LinkComponent}
            />
          ))}
          {specRefs.map((ref, index) => {
            const atomId = parseSpecRef(ref);
            return atomId ? (
              <CitationRow
                key={`${index}:${ref}`}
                direction="out"
                relation="design"
                tone="neutral"
                slug={atomId}
                href={hrefFor(atomId)}
                icon={<DraftingCompass className="size-3.5" />}
                Link={LinkComponent}
              />
            ) : (
              <code key={`${index}:${ref}`} className="flex min-h-8 min-w-0 items-center break-all text-muted-foreground text-xs">
                {ref}
              </code>
            );
          })}
        </div>
      )}
    </section>
  );
}
