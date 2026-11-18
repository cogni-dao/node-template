// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-pull-links`
 * Purpose: Helps a human open the code a work item ships, first thing on the item (story.0069).
 * Scope: Presentation of the item's `pr` (the deliverable the ladder gates) and each `externalRefs` entry of kind `pr`. Each PR is one
 *   `CitationRow` `→ pr owner/repo#N` that opens in a new tab. No fetch: the refs ride the item read, the same fields agents read.
 * Invariants:
 *   - ONE_ROW_RENDERER: PR rows are `CitationRow` in `CITATION_LIST_CLASS`, as Moves and Design draw.
 *   - MANY_PRS: `pr` first, then each other PR once; an item with none draws nothing.
 *   - HTTPS_ONLY_LINKS: only an https URL becomes an href; a label reads owner/repo#N only for a github.com pull URL.
 * Side-effects: none
 * Links: hub work-item-design-links, ./work-design-links.tsx, ./citation-links.tsx
 * @public
 */

import type { ReactElement } from "react";

import {
  CITATION_HEADING_CLASS,
  CITATION_LIST_CLASS,
  type CitationLinkComponent,
  CitationRow,
} from "./citation-links.js";

/** A PR opens where it lives, in a new tab. */
export const ExternalCitationLink: CitationLinkComponent = ({ entityId: _entityId, ...props }) => (
  <a target="_blank" rel="noreferrer" {...props} />
);

const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** "owner/repo#N" for a GitHub pull URL, else the URL itself. */
export function pullLabel(url: string): string {
  const match = PULL_URL.exec(url);
  return match ? `${match[1]}#${match[2]}` : url;
}

/** The item's PR URLs: `pr` first, then each https `externalRefs` entry of kind `pr`, each once. */
export function pullUrls(
  pr: string | null | undefined,
  externalRefs: readonly { readonly kind: string; readonly url?: string | undefined }[] = [],
): string[] {
  const urls = [pr, ...externalRefs.filter((ref) => ref.kind === "pr").map((ref) => ref.url)];
  return [...new Set(urls.filter((url): url is string => typeof url === "string" && url.startsWith("https://")))];
}

export function WorkPullLinks({
  pr,
  externalRefs,
  LinkComponent = ExternalCitationLink,
}: {
  readonly pr?: string | null | undefined;
  readonly externalRefs?: readonly { readonly kind: string; readonly url?: string | undefined }[];
  /** The node's external link. Default: an anchor that opens a new tab. */
  readonly LinkComponent?: CitationLinkComponent;
}): ReactElement | null {
  const urls = pullUrls(pr, externalRefs);
  if (urls.length === 0) return null;
  return (
    <section aria-label="Pull requests" data-work-pulls="links" className="flex flex-col gap-1.5">
      <h3 className={CITATION_HEADING_CLASS}>{urls.length === 1 ? "PR" : "PRs"}</h3>
      <div className={CITATION_LIST_CLASS}>
        {urls.map((url) => (
          <CitationRow key={url} direction="out" relation="pr" tone="neutral" slug={pullLabel(url)} href={url} Link={LinkComponent} />
        ))}
      </div>
    </section>
  );
}
