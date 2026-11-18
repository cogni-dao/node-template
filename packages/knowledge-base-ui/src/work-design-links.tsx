// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-design-links`
 * Purpose: Helps a human decide whether a work item is built on a design, and opens that design in one click (story.0069).
 * Scope: Presentation of the item's `specRefs`. Each `knowledge:<id>` entry is one `CitationRow` `→ design <id>`, the row Moves
 *   and Artifacts draw. An entry written before the type stays one plain text line. No fetch: the refs ride the item read.
 * Invariants:
 *   - ONE_ROW_RENDERER: design rows are `CitationRow` in `CITATION_LIST_CLASS`; no bespoke layout.
 *   - ONE_SPEC_REF_TYPE: the package's `parseSpecRef` decides what is a design link; no second pattern here.
 *   - EMPTY_DRAWS_NOTHING: an item with no refs draws no section, as before the type.
 * Side-effects: none
 * Links: hub work-item-design-links, ./citation-links.tsx, ./goals/work-move-links.tsx
 * @public
 */

import { parseSpecRef } from "@cogni/work-items";
import type { ReactElement } from "react";

import {
  CITATION_HEADING_CLASS,
  CITATION_LIST_CLASS,
  type CitationLinkComponent,
  CitationRow,
  DefaultCitationLink,
} from "./citation-links.js";

/** A design atom's page on a node that mounts the Knowledge pages at `/knowledge`. */
export const defaultDesignHref = (atomId: string): string => `/knowledge/${encodeURIComponent(atomId)}`;

export function WorkDesignLinks({
  specRefs,
  hrefFor = defaultDesignHref,
  LinkComponent = DefaultCitationLink,
}: {
  readonly specRefs: readonly string[];
  /** The node's page for one atom id. Default `/knowledge/{id}`. */
  readonly hrefFor?: (atomId: string) => string;
  /** The node's link (for example one that peeks an entry in a side sheet). Default `<a>`. */
  readonly LinkComponent?: CitationLinkComponent;
}): ReactElement | null {
  if (specRefs.length === 0) return null;
  return (
    <section aria-label="Design" data-work-design="links" className="flex flex-col gap-1.5">
      <h3 className={CITATION_HEADING_CLASS}>Design</h3>
      <div className={CITATION_LIST_CLASS}>
        {specRefs.map((ref) => {
          const atomId = parseSpecRef(ref);
          return atomId ? (
            <CitationRow
              key={ref}
              direction="out"
              relation="design"
              tone="neutral"
              slug={atomId}
              href={hrefFor(atomId)}
              Link={LinkComponent}
            />
          ) : (
            <code key={ref} className="flex min-h-8 min-w-0 items-center break-all text-muted-foreground text-xs">
              {ref}
            </code>
          );
        })}
      </div>
    </section>
  );
}
