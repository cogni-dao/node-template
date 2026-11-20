// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-item-view`
 * Purpose: Helps a human decide what the item is, whether its latest review lets it move, and why it moved.
 * Scope: The whole work-item view (story.0085), every section in one order: header, PRs, Moves, Design, Artifacts, Expectations,
 *   status, Evaluation, Summary, Outcome, History, Links and the fields. The node passes its read client, URL state, links,
 *   markdown renderer and header slots; it keeps the page, the sheet and the route. Page 1 of artifacts, history and links rides
 *   the item read; an older page comes from the client.
 * Invariants:
 *   - ONE_VIEW: a node renders the item only through this view; no section lives in a node app.
 *   - SECTIONS_NEED_THEIR_PARTS: Artifacts and History render only when the item read carries them.
 *   - ITEM_SCOPED_URL: `artifact`, `artifactsCursor` and `historyCursor` belong to this item; links set them through `itemHref`.
 *   - BOUNDED: older pages replace the list; roadmap links read at most four pages (bounded-data-reads).
 * Side-effects: IO (older ref pages, roadmap link pages and expectations through the client)
 * Links: hub work-item-view-capability, work-item-artifacts, change-history-design, work-item-design-links
 * @public
 */

"use client";

import { type ArtifactKind, parseArtifactSubject, scorecardMarkdown, type WorkItemReadDto } from "@cogni/work-items";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, type ReactElement, type ReactNode, useCallback } from "react";

import {
  CITATION_HEADING_CLASS,
  CITATION_LIST_CLASS,
  type CitationLinkComponent,
  CitationLinks,
  CitationRow,
  type CitationTone,
  DefaultCitationLink,
} from "./citation-links.js";
import { WorkMoveLinks } from "./goals/work-move-links.js";
import { formatRelativeTime, RelativeTime } from "./relative-time.js";
import { WorkDesignLinks } from "./work-design-links.js";
import { WorkExpectations } from "./work-edo.js";
import type { WorkItemScopedParam } from "./work-item-params.js";
import type { WorkItemClient } from "./work-item-client.js";
import { workItemErrorStatus } from "./work-item-client.js";
import { StatusPill, TypeIcon } from "./work-item-icons.js";
import { hasScores, WorkItemScoresRadar } from "./work-item-scores-radar.js";
import type { WorkMetric } from "./work-metrics.js";
import { WORK_SECTION_EMPTY_CLASS, WorkPullLinks } from "./work-pull-links.js";

const KIND_TITLES: Readonly<Record<ArtifactKind, string>> = {
  triage: "Triage",
  design_review: "Design review",
  implementation_review: "Implementation review",
  validation: "Validation",
  closeout: "Closeout",
};

/** The pill's color is the verdict alone: green lets the item move, yellow asks for changes, red fails, a triage route is neutral. */
function verdictTone(verdict: string): CitationTone {
  if (verdict === "approve" || verdict === "pass" || verdict === "done") return "positive";
  if (verdict === "request_changes" || verdict === "notes") return "warning";
  if (verdict === "fail") return "negative";
  return "neutral";
}

/** What an artifact judged, short: "PR #409 @ 2dea498", "inbox cef83e76", "build 2dea498", or the item. */
function subjectLabel(subject: string): string {
  const parsed = parseArtifactSubject(subject);
  switch (parsed?.form) {
    case "pr":
      return `PR #${parsed.url.split("/").pop()} @ ${parsed.head.slice(0, 7)}`;
    case "knowledge":
      return `inbox ${parsed.contribution.slice(-8)}`;
    case "build":
      return `build ${parsed.buildSha.slice(0, 7)}`;
    default:
      return "this item";
  }
}

/** The row text: kind, its iteration number and what it judged, e.g. "Design review 3 · inbox cef83e76". */
function artifactRowLabel(
  ref: { readonly kind: ArtifactKind; readonly verdict: string; readonly subject: string; readonly seq: number },
  refs: readonly { readonly kind: ArtifactKind; readonly seq: number }[]
): string {
  if (ref.kind === "triage") return `Triage → route to ${ref.verdict}`;
  const iteration = refs.filter((other) => other.kind === ref.kind && other.seq <= ref.seq).length;
  return `${KIND_TITLES[ref.kind]} ${iteration} · ${subjectLabel(ref.subject)}`;
}

/** Link pages the Design section reads for roadmaps: the read's first page, then at most three more (bounded-data-reads). */
export const ROADMAP_LINK_PAGES = 4;

type CitationLinkDto = NonNullable<WorkItemReadDto["links"]>["items"][number];
type LinkPage = { readonly items: readonly CitationLinkDto[]; readonly nextCursor: string | null };

/** The knowledge sources of the item's incoming `tracks` edges: the roadmaps that track it (story.0069). */
function roadmapSources(pages: readonly LinkPage[]): string[] {
  return pages
    .flatMap((page) => page.items)
    .filter((link) => link.direction === "in" && link.citationType === "tracks" && link.source.kind === "knowledge")
    .map((link) => link.source.id);
}

/** Page 1 rides the item read; later pages follow `nextCursor` through the client, within `ROADMAP_LINK_PAGES`. */
function useRoadmaps(
  read: WorkItemReadDto | null,
  client: WorkItemClient
): { readonly ids: string[]; readonly partial: boolean } {
  const first = read?.links && !read.links.unavailable ? read.links : undefined;
  const more = useQuery({
    queryKey: ["work-item-roadmap-links", read?.id, first?.nextCursor],
    queryFn: async ({ signal }) => {
      const pages: LinkPage[] = [];
      let cursor = first?.nextCursor ?? null;
      while (cursor !== null && pages.length < ROADMAP_LINK_PAGES - 1) {
        const page = await client.fetchCitationLinks(read?.id as string, cursor, signal);
        pages.push({ items: page.links, nextCursor: page.nextCursor });
        cursor = page.nextCursor;
      }
      return pages;
    },
    enabled: first?.nextCursor != null,
    retry: false,
  });
  if (!first) return { ids: [], partial: read?.links?.unavailable === true };
  const pages = [first, ...(more.data ?? [])];
  const last = pages[pages.length - 1];
  return { ids: roadmapSources(pages), partial: last?.nextCursor != null };
}

const ROW = "flex min-w-0 items-center justify-between gap-3";
const ROW_TITLE = "min-w-0 truncate";
const ROW_TIME = "shrink-0 text-muted-foreground text-xs";
// Tap targets are at least 24px tall (frontend-development section 5).
const PAGE_LINK = "inline-flex min-h-6 items-center text-muted-foreground text-xs underline";
const NO_MOVES: WorkMetric[] = [];


/** The page's search params: `URLSearchParams` or Next's `ReadonlyURLSearchParams`. */
export type WorkItemSearchParams = Pick<URLSearchParams, "get" | "toString">;

type SubjectRef = WorkItemReadDto["assignees"][number];

function assigneeLabel(a: SubjectRef): string {
  switch (a.kind) {
    case "user":
      return a.userId;
    case "agent":
      return a.agentId;
    case "system":
      return a.serviceId;
  }
}

/** A header part: the node passes its sheet's header, title and description so a dialog stays named. */
export type WorkItemHeaderSlot = ComponentType<{ readonly className?: string; readonly children?: ReactNode }>;

const DefaultHeader: WorkItemHeaderSlot = ({ className, children }) => <div className={className}>{children}</div>;
const DefaultTitle: WorkItemHeaderSlot = ({ className, children }) => <h2 className={className}>{children}</h2>;
const DefaultDescription: WorkItemHeaderSlot = ({ className, children }) => <p className={className}>{children}</p>;

export interface WorkItemViewProps {
  /** The item read, ideally with every part in `WORK_ITEM_VIEW_INCLUDES`. */
  readonly item: WorkItemReadDto | null;
  readonly itemId?: string | undefined;
  readonly isLoading?: boolean;
  /** A failed item read. An error whose `status` is 404 reads as not found; any other as unavailable. */
  readonly error?: unknown;
  /** The node's read client, for older pages, roadmap links, Links and Expectations. */
  readonly client: WorkItemClient;
  /** The page's search params. Default: none. */
  readonly searchParams?: WorkItemSearchParams;
  /** The node's URL for this item with these params, for example `/work/items/{id}?{params}`. */
  readonly itemHref: (id: string, params: URLSearchParams) => string;
  /** The node's in-page link. It must keep the scroll position. Default `<a>`. */
  readonly Link?: CitationLinkComponent;
  /** The node's link to another entity, for example one that peeks it in a side sheet. Default `<a>`. */
  readonly PeekLink?: CitationLinkComponent;
  /** The node's markdown renderer: GFM, raw HTML dropped. */
  readonly Markdown: ComponentType<{ readonly content: string }>;
  readonly Header?: WorkItemHeaderSlot;
  readonly Title?: WorkItemHeaderSlot;
  readonly Description?: WorkItemHeaderSlot;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement | null {
  if (!children) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

const NO_PARAMS = new URLSearchParams();

export function WorkItemView({
  item,
  itemId,
  isLoading = false,
  error = null,
  client,
  searchParams = NO_PARAMS,
  itemHref,
  Link = DefaultCitationLink,
  PeekLink = DefaultCitationLink,
  Markdown,
  Header = DefaultHeader,
  Title = DefaultTitle,
  Description = DefaultDescription,
}: WorkItemViewProps): ReactElement {
  const isNotFound = workItemErrorStatus(error) === 404;
  const hasOperationalError = !isLoading && !isNotFound && (!item || !!error);
  const read = item;
  const artifactsCursor = searchParams.get("artifactsCursor");
  const historyCursor = searchParams.get("historyCursor");
  const scopedHref = (id: string, key: WorkItemScopedParam, value: string | null): string => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete(key);
    else params.set(key, value);
    return itemHref(id, params);
  };
  // Page 1 rides the item read; an older page comes from the refs view of its route and replaces the list.
  const olderArtifacts = useQuery({
    queryKey: ["work-item-artifact-refs", read?.id, artifactsCursor],
    queryFn: ({ signal }) => client.fetchArtifactRefs(read?.id as string, artifactsCursor as string, signal),
    enabled: read?.artifactRefs !== undefined && artifactsCursor !== null,
    retry: false,
  });
  const olderHistory = useQuery({
    queryKey: ["work-item-history-refs", read?.id, historyCursor],
    queryFn: ({ signal }) => client.fetchHistoryRefs(read?.id as string, historyCursor as string, signal),
    enabled: read?.historyRefs !== undefined && historyCursor !== null,
    retry: false,
  });
  // CitationLinks wants a stable loader.
  const loadLinks = useCallback((id: string, cursor?: string) => client.fetchCitationLinks(id, cursor), [client]);
  const artifactPage = artifactsCursor === null ? read?.artifactRefs : olderArtifacts.data;
  const historyPage = historyCursor === null ? read?.historyRefs : olderHistory.data;
  const artifactsLoading = artifactsCursor !== null && olderArtifacts.isLoading;
  const historyLoading = historyCursor !== null && olderHistory.isLoading;
  const artifactsUnavailable = artifactPage?.unavailable === true || (artifactsCursor !== null && olderArtifacts.isError);
  const historyUnavailable = historyPage?.unavailable === true || (historyCursor !== null && olderHistory.isError);
  const roadmaps = useRoadmaps(read, client);
  const selected = read?.artifact;
  const selectedArtifact = selected !== undefined && "id" in selected ? selected : undefined;
  const selectedBody = selectedArtifact && (
    // Real reviews run to thousands of characters: the open one scrolls inside its row, so the list stays in view.
    <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto py-2 pl-6 text-sm">
      {selectedArtifact.note && <span className="text-muted-foreground">{selectedArtifact.note}</span>}
      {selectedArtifact.body ? (
        <Markdown content={selectedArtifact.body} />
      ) : selectedArtifact.rows?.length ? (
        <Markdown content={scorecardMarkdown(selectedArtifact.rows)} />
      ) : selectedArtifact.url ? (
        <a href={selectedArtifact.url} className="underline" target="_blank" rel="noreferrer">
          {selectedArtifact.url}
        </a>
      ) : null}
    </div>
  );

  return (
    <>
      {isLoading && (
        <Header className="px-6 py-16 text-center sm:text-center">
          <Title>Loading work item</Title>
          <Description>Loading details for {itemId ?? "the selected work item"}.</Description>
        </Header>
      )}

      {!isLoading && isNotFound && (
        <Header className="px-6 py-16 text-center sm:text-center">
          <Title>Work item not found</Title>
          <Description className="text-xs leading-relaxed">
            No work item with id <code className="font-mono">{itemId}</code> exists, or it isn&apos;t visible to you.
          </Description>
        </Header>
      )}

      {hasOperationalError && (
        <Header className="px-6 py-16 text-center sm:text-center">
          <Title>Unable to load work item</Title>
          <Description className="text-xs leading-relaxed">
            The work-item route could not load <code className="font-mono">{itemId ?? "the selected item"}</code>. Try
            again shortly.
          </Description>
        </Header>
      )}

      {!isLoading && !error && item && (
        <>
          <Header>
            <div className="flex items-center gap-2">
              <TypeIcon type={item.type} className="size-5" />
              <span className="font-mono text-muted-foreground text-sm">{item.id}</span>
            </div>
            <Title className="text-lg leading-snug">{item.title}</Title>
            <Description>
              Details for <span className="font-mono">{item.id}</span>.
            </Description>
          </Header>

          <div className="mt-6 flex flex-col gap-5 px-1">
            {/* PRs first: the code the item ships, `pr` then each other PR (story.0069). */}
            <WorkPullLinks pr={item.pr} externalRefs={item.externalRefs} />
            <WorkMoveLinks moves={item.moves ?? NO_MOVES} labels={item.labels} LinkComponent={PeekLink} />
            {/* Design, between Moves and Artifacts: the design atoms the item is built against (story.0069). */}
            <WorkDesignLinks
              specRefs={item.specRefs}
              roadmapIds={roadmaps.ids}
              roadmapsPartial={roadmaps.partial}
              LinkComponent={PeekLink}
            />
            {/* Artifacts, right below Design and drawn like Moves: each review or validation that lets the item move (story.0058).
                The selected one opens inline under its row; selecting it again closes it. */}
            {read?.artifactRefs !== undefined && (
              <section aria-label="Artifacts" className="flex flex-col gap-1.5">
                <h3 className={CITATION_HEADING_CLASS}>Artifacts</h3>
                {artifactsLoading ? (
                  <span className="text-muted-foreground text-sm">Loading reviews</span>
                ) : artifactsUnavailable ? (
                  <span className="text-muted-foreground text-sm">Reviews are unavailable</span>
                ) : !artifactPage?.refs.length ? (
                  <span className={WORK_SECTION_EMPTY_CLASS}>No reviews yet</span>
                ) : (
                  <div className={CITATION_LIST_CLASS}>
                    {artifactPage.refs.map((ref) => {
                      const open = selectedArtifact?.id === ref.id;
                      return (
                        <div key={ref.id} className="flex flex-col">
                          <CitationRow
                            direction="out"
                            relation={ref.kind === "triage" ? "routed" : ref.verdict.replace(/_/g, " ")}
                            tone={verdictTone(ref.verdict)}
                            slug={artifactRowLabel(ref, artifactPage.refs)}
                            href={scopedHref(item.id, "artifact", open ? null : ref.id)}
                            hoverTitle={[ref.note, formatRelativeTime(ref.createdAt)].filter(Boolean).join(" · ")}
                            Link={Link}
                          />
                          {open && selectedBody}
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* A selected artifact that is not on this page (a deep link, or after Older) opens below the list. */}
                {selectedArtifact && !artifactPage?.refs.some((ref) => ref.id === selectedArtifact.id) && (
                  <div className={CITATION_LIST_CLASS}>
                    <CitationRow
                      direction="out"
                      relation={selectedArtifact.verdict.replace(/_/g, " ")}
                      tone={verdictTone(selectedArtifact.verdict)}
                      slug={`${KIND_TITLES[selectedArtifact.kind]} · ${subjectLabel(selectedArtifact.subject)}`}
                      href={scopedHref(item.id, "artifact", null)}
                      hoverTitle={[selectedArtifact.note, formatRelativeTime(selectedArtifact.createdAt)]
                        .filter(Boolean)
                        .join(" · ")}
                      Link={Link}
                    />
                    {selectedBody}
                  </div>
                )}
                {selected !== undefined && !("id" in selected) && (
                  <span className="text-muted-foreground text-sm">
                    {"notFound" in selected ? "Artifact not found" : "The artifact is unavailable"}
                  </span>
                )}
                {(artifactPage?.nextCursor != null || artifactsCursor !== null) && (
                  <div className="flex gap-3">
                    {artifactsCursor !== null && (
                      <Link href={scopedHref(item.id, "artifactsCursor", null)} className={PAGE_LINK}>
                        Newest
                      </Link>
                    )}
                    {artifactPage?.nextCursor != null && (
                      <Link
                        href={scopedHref(item.id, "artifactsCursor", String(artifactPage.nextCursor))}
                        className={PAGE_LINK}
                      >
                        Older
                      </Link>
                    )}
                  </div>
                )}
              </section>
            )}

            <WorkExpectations itemId={item.id} moves={item.moves ?? NO_MOVES} load={client.fetchExpectations} />
            {/* Status + Priority row */}
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill status={item.status} />
              {item.priority != null && (
                <span className="inline-flex rounded-md bg-muted px-2 py-0.5 font-medium text-xs">{item.priority}</span>
              )}
              {item.estimate != null && <span className="text-muted-foreground text-xs">Est: {item.estimate}</span>}
            </div>

            {/* Evaluation (story.5111) */}
            {hasScores(item.scores) && (
              <Field label="Evaluation">
                <WorkItemScoresRadar scores={item.scores} />
              </Field>
            )}

            {item.summary && (
              <Field label="Summary">
                <Markdown content={item.summary} />
              </Field>
            )}

            {item.outcome && (
              <Field label="Outcome">
                <Markdown content={item.outcome} />
              </Field>
            )}

            {/* History: why the item changed, newest first */}
            {read?.historyRefs !== undefined && (
              <Field label="History">
                {historyLoading ? (
                  <span className="text-muted-foreground">Loading history</span>
                ) : historyUnavailable ? (
                  <span className="text-muted-foreground">History is unavailable</span>
                ) : !historyPage?.refs.length ? (
                  <span className="text-muted-foreground">No history yet</span>
                ) : (
                  <div className="flex flex-col gap-1">
                    {historyPage.refs.map((ref, index) => {
                      const created =
                        ref.reason === null && historyPage.nextCursor === null && index === historyPage.refs.length - 1;
                      const text = ref.reason ?? (created ? "Created" : "No reason recorded");
                      return (
                        <div key={ref.commit} className={ROW}>
                          <span className={ROW_TITLE} title={text}>
                            {text}
                          </span>
                          <RelativeTime iso={ref.at} className={ROW_TIME} />
                        </div>
                      );
                    })}
                  </div>
                )}
                {(historyPage?.nextCursor != null || historyCursor !== null) && (
                  <div className="mt-1 flex gap-3">
                    {historyCursor !== null && (
                      <Link href={scopedHref(item.id, "historyCursor", null)} className={PAGE_LINK}>
                        Newest
                      </Link>
                    )}
                    {historyPage?.nextCursor != null && (
                      <Link href={scopedHref(item.id, "historyCursor", historyPage.nextCursor)} className={PAGE_LINK}>
                        Older
                      </Link>
                    )}
                  </div>
                )}
              </Field>
            )}

            <CitationLinks entityId={item.id} loadPage={loadLinks} LinkComponent={PeekLink} />

            {item.projectId && <Field label="Project">{item.projectId}</Field>}

            {/* Branch; the PRs lead the item */}
            {item.branch && (
              <Field label="Branch">
                <code className="text-xs">{item.branch}</code>
              </Field>
            )}

            {item.blockedBy && (
              <Field label="Blocked By">
                <span className="font-mono text-destructive text-xs">{item.blockedBy}</span>
              </Field>
            )}

            {item.labels.length > 0 && (
              <Field label="Labels">
                <div className="flex flex-wrap gap-1.5">
                  {item.labels.map((l) => (
                    <span key={l} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                      {l}
                    </span>
                  ))}
                </div>
              </Field>
            )}

            {item.assignees.length > 0 && (
              <Field label="Assignees">
                <div className="flex flex-wrap gap-2">
                  {item.assignees.map((a) => (
                    <span key={`${a.kind}-${assigneeLabel(a)}`} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                      {assigneeLabel(a)}
                    </span>
                  ))}
                </div>
              </Field>
            )}

            <div className="flex gap-6 border-t pt-4 text-muted-foreground text-xs">
              <span>Created: {item.createdAt.slice(0, 10)}</span>
              <span>Updated: {item.updatedAt.slice(0, 10)}</span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
