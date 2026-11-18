// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkItemDetailBody`
 * Purpose: Helps a human decide what the item is, whether its latest review lets it move, and why it moved.
 * Scope: Presentation of one item read. Artifacts sits right below Moves in the same bordered `CitationRow` list; the
 *   selected artifact (the item read's `artifact`) opens inline under its row. History lists why the item changed. Page 1
 *   of each comes from the item read, an older page from the refs views (story.0058).
 * Invariants:
 *   - EXISTING_PARTS_ONLY: CitationRow and its list classes (as Moves), Field, Link, Markdown and RelativeTime; Design rows come from the
 *     package's `WorkDesignLinks` (story.0069); no new component here.
 *   - SECTIONS_NEED_THEIR_PARTS: Artifacts and History render only when the item read carries them.
 *   - ITEM_SCOPED_URL: `artifact`, `artifactsCursor` and `historyCursor` belong to this item; links set them with scroll off.
 * Side-effects: IO (older ref pages, only when a cursor parameter is set)
 * Links: hub work-item-artifacts, change-history-design, ../_lib/workItemNavigation.ts
 * @internal
 */

"use client";

import {
	CITATION_HEADING_CLASS,
	CITATION_LIST_CLASS,
	type CitationLinkComponent,
	type CitationTone,
	CitationRow,
	formatRelativeTime,
	hasScores,
	RelativeTime,
	WorkItemScoresRadar,
	WorkDesignLinks,
	WorkExpectations,
	WorkPullLinks,
	type WorkMetric,
	WORK_SECTION_EMPTY_CLASS,
} from "@cogni/knowledge-base-ui";
import { WorkMoveLinks } from "@cogni/knowledge-base-ui/goals";
import type { WorkItemDto, WorkItemsGetOutput } from "@cogni/node-contracts";
import { type ArtifactKind, parseArtifactSubject, scorecardMarkdown } from "@cogni/work-items";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/sheet";
import type { ReactElement } from "react";
import { Markdown } from "@/components/markdown";

import { type CitationLinkDto, fetchCitationLinks } from "../../_api/fetchCitationLinks";
import { EntityCitationLinks } from "../../_components/EntityCitationLinks";
import { PeekLink } from "../../_components/EntityPeek";
import {
	fetchArtifactRefs,
	fetchHistoryRefs,
	isWorkItemNotFoundError,
} from "../_api/fetchWorkItems";
import { fetchWorkExpectations } from "../_api/fetchWorkExpectations";
import { itemScopedHref } from "../_lib/workItemNavigation";
import { StatusPill, TypeIcon } from "./work-item-icons";

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

/** What an artifact judged, short: "PR #409 @ 2dea498", "inbox cef83e76", "build 2dea498", or the item. The package parses subjects. */
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
	refs: readonly { readonly kind: ArtifactKind; readonly seq: number }[],
): string {
	if (ref.kind === "triage") return `Triage → route to ${ref.verdict}`;
	const iteration = refs.filter((other) => other.kind === ref.kind && other.seq <= ref.seq).length;
	return `${KIND_TITLES[ref.kind]} ${iteration} · ${subjectLabel(ref.subject)}`;
}

/** The shared row's link: stays on the page, keeps scroll, never peeks (an artifact is not a knowledge entry). */
const ScrollKeepingLink: CitationLinkComponent = ({ entityId: _entityId, href, ...props }) => (
	<Link href={href} scroll={false} {...props} />
);


/** Link pages the Design section reads for roadmaps: the read's first page, then at most three more (bounded-data-reads). */
const ROADMAP_LINK_PAGES = 4;

type LinkPage = { readonly items: readonly CitationLinkDto[]; readonly nextCursor: string | null };

/** The knowledge sources of the item's incoming `tracks` edges: the roadmaps that track it (story.0069). */
function roadmapSources(pages: readonly LinkPage[]): string[] {
	return pages
		.flatMap((page) => page.items)
		.filter((link) => link.direction === "in" && link.citationType === "tracks" && link.source.kind === "knowledge")
		.map((link) => link.source.id);
}

/** Page 1 rides the item read; later pages follow `nextCursor` through the citations route, within `ROADMAP_LINK_PAGES`. */
function useRoadmaps(read: WorkItemsGetOutput | null): { readonly ids: string[]; readonly partial: boolean } {
	const first = read?.links && !read.links.unavailable ? read.links : undefined;
	const more = useQuery({
		queryKey: ["work-item-roadmap-links", read?.id, first?.nextCursor],
		queryFn: async ({ signal }) => {
			const pages: LinkPage[] = [];
			let cursor = first?.nextCursor ?? null;
			while (cursor !== null && pages.length < ROADMAP_LINK_PAGES - 1) {
				const page = await fetchCitationLinks(read?.id as string, cursor, signal);
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
const NO_PARAMS = new URLSearchParams();
// Tap targets are at least 24px tall (frontend-development section 5).
const PAGE_LINK = "inline-flex min-h-6 items-center text-muted-foreground text-xs underline";

type SubjectRef = WorkItemDto["assignees"][number];
const NO_MOVES: WorkMetric[] = [];

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

export interface WorkItemDetailBodyProps {
	readonly item: WorkItemsGetOutput | WorkItemDto | null;
	readonly itemId?: string;
	readonly isLoading?: boolean;
	readonly error?: Error | null;
}

function Field({
	label,
	children,
}: {
	readonly label: string;
	readonly children: React.ReactNode;
}): ReactElement | null {
	if (!children) return null;
	return (
		<div className="flex flex-col gap-1">
			<span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
				{label}
			</span>
			<div className="text-sm">{children}</div>
		</div>
	);
}

export function WorkItemDetailBody({
	item,
	itemId,
	isLoading = false,
	error = null,
}: WorkItemDetailBodyProps): ReactElement {
	const isNotFound = isWorkItemNotFoundError(error);
	const hasOperationalError = !isLoading && !isNotFound && (!item || !!error);
	const read: WorkItemsGetOutput | null = item;
	// Outside the app router (a host that renders the body alone) there are no parameters.
	const searchParams = useSearchParams() ?? NO_PARAMS;
	const artifactsCursor = searchParams.get("artifactsCursor");
	const historyCursor = searchParams.get("historyCursor");
	// Page 1 rides the item read; an older page comes from the refs view of its route and replaces the list.
	const olderArtifacts = useQuery({
		queryKey: ["work-item-artifact-refs", read?.id, artifactsCursor],
		queryFn: ({ signal }) => fetchArtifactRefs(read?.id as string, artifactsCursor as string, signal),
		enabled: read?.artifactRefs !== undefined && artifactsCursor !== null,
		retry: false,
	});
	const olderHistory = useQuery({
		queryKey: ["work-item-history-refs", read?.id, historyCursor],
		queryFn: ({ signal }) => fetchHistoryRefs(read?.id as string, historyCursor as string, signal),
		enabled: read?.historyRefs !== undefined && historyCursor !== null,
		retry: false,
	});
	const artifactPage = artifactsCursor === null ? read?.artifactRefs : olderArtifacts.data;
	const historyPage = historyCursor === null ? read?.historyRefs : olderHistory.data;
	const artifactsLoading = artifactsCursor !== null && olderArtifacts.isLoading;
	const historyLoading = historyCursor !== null && olderHistory.isLoading;
	const artifactsUnavailable = artifactPage?.unavailable === true || (artifactsCursor !== null && olderArtifacts.isError);
	const historyUnavailable = historyPage?.unavailable === true || (historyCursor !== null && olderHistory.isError);
	const roadmaps = useRoadmaps(read);
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
				<Link href={selectedArtifact.url} className="underline" target="_blank" rel="noreferrer">
					{selectedArtifact.url}
				</Link>
			) : null}
		</div>
	);

	return (
		<>
			{isLoading && (
				<SheetHeader className="px-6 py-16 text-center sm:text-center">
					<SheetTitle>Loading work item</SheetTitle>
					<SheetDescription>
						Loading details for {itemId ?? "the selected work item"}.
					</SheetDescription>
				</SheetHeader>
			)}

			{!isLoading && isNotFound && (
				<SheetHeader className="px-6 py-16 text-center sm:text-center">
					<SheetTitle>Work item not found</SheetTitle>
					<SheetDescription className="text-xs leading-relaxed">
						No work item with id <code className="font-mono">{itemId}</code>{" "}
						exists, or it isn&apos;t visible to you.
					</SheetDescription>
				</SheetHeader>
			)}

			{hasOperationalError && (
				<SheetHeader className="px-6 py-16 text-center sm:text-center">
					<SheetTitle>Unable to load work item</SheetTitle>
					<SheetDescription className="text-xs leading-relaxed">
						The work-item route could not load{" "}
						<code className="font-mono">{itemId ?? "the selected item"}</code>.
						Try again shortly.
					</SheetDescription>
				</SheetHeader>
			)}

			{!isLoading && !error && item && (
				<>
					<SheetHeader>
						<div className="flex items-center gap-2">
							<TypeIcon type={item.type} className="size-5" />
							<span className="font-mono text-muted-foreground text-sm">
								{item.id}
							</span>
						</div>
						<SheetTitle className="text-lg leading-snug">
							{item.title}
						</SheetTitle>
						<SheetDescription>
							Details for <span className="font-mono">{item.id}</span>.
						</SheetDescription>
					</SheetHeader>

					<div className="mt-6 flex flex-col gap-5 px-1">
						{/* PRs first: the code the item ships, `pr` then each other PR (story.0069). */}
						<WorkPullLinks pr={item.pr} externalRefs={item.externalRefs} />
						<WorkMoveLinks
							moves={item.moves ?? NO_MOVES}
							labels={item.labels}
							LinkComponent={PeekLink}
						/>
						{/* Design, between Moves and Artifacts: the design atoms the item is built against (story.0069). */}
						<WorkDesignLinks specRefs={item.specRefs} roadmapIds={roadmaps.ids} roadmapsPartial={roadmaps.partial} LinkComponent={PeekLink} />
						{/* Artifacts, right below Moves and drawn like it: each review or validation that lets the item move (story.0058).
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
											const open = selected !== undefined && "id" in selected && selected.id === ref.id;
											return (
												<div key={ref.id} className="flex flex-col">
													<CitationRow
														direction="out"
														relation={ref.kind === "triage" ? "routed" : ref.verdict.replace(/_/g, " ")}
														tone={verdictTone(ref.verdict)}
														slug={artifactRowLabel(ref, artifactPage.refs)}
														href={itemScopedHref(item.id, searchParams, "artifact", open ? null : ref.id)}
														hoverTitle={[ref.note, formatRelativeTime(ref.createdAt)].filter(Boolean).join(" · ")}
														Link={ScrollKeepingLink}
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
											href={itemScopedHref(item.id, searchParams, "artifact", null)}
											hoverTitle={[selectedArtifact.note, formatRelativeTime(selectedArtifact.createdAt)].filter(Boolean).join(" · ")}
											Link={ScrollKeepingLink}
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
											<Link href={itemScopedHref(item.id, searchParams, "artifactsCursor", null)} scroll={false} className={PAGE_LINK}>
												Newest
											</Link>
										)}
										{artifactPage?.nextCursor != null && (
											<Link
												href={itemScopedHref(item.id, searchParams, "artifactsCursor", String(artifactPage.nextCursor))}
												scroll={false}
												className={PAGE_LINK}
											>
												Older
											</Link>
										)}
									</div>
								)}
							</section>
						)}

						<WorkExpectations
							itemId={item.id}
							moves={item.moves ?? NO_MOVES}
							load={fetchWorkExpectations}
						/>
						{/* Status + Priority row */}
						<div className="flex flex-wrap items-center gap-3">
							<StatusPill status={item.status} />
							{item.priority != null && (
								<span className="inline-flex rounded-md bg-muted px-2 py-0.5 font-medium text-xs">
									{item.priority}
								</span>
							)}
							{item.estimate != null && (
								<span className="text-muted-foreground text-xs">
									Est: {item.estimate}
								</span>
							)}
						</div>

						{/* Evaluation (story.5111) */}
						{hasScores(item.scores) && (
							<Field label="Evaluation">
								<WorkItemScoresRadar scores={item.scores} />
							</Field>
						)}

						{/* Summary */}
						{item.summary && (
							<Field label="Summary">
								<Markdown content={item.summary} />
							</Field>
						)}

						{/* Outcome */}
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
											const created = ref.reason === null && historyPage.nextCursor === null && index === historyPage.refs.length - 1;
											const text = ref.reason ?? (created ? "Created" : "No reason recorded");
											return (
											<div key={ref.commit} className={ROW}>
												<span className={ROW_TITLE} title={text}>{text}</span>
												<RelativeTime iso={ref.at} className={ROW_TIME} />
											</div>
											);
										})}
									</div>
								)}
								{(historyPage?.nextCursor != null || historyCursor !== null) && (
									<div className="mt-1 flex gap-3">
										{historyCursor !== null && (
											<Link href={itemScopedHref(item.id, searchParams, "historyCursor", null)} scroll={false} className={PAGE_LINK}>
												Newest
											</Link>
										)}
										{historyPage?.nextCursor != null && (
											<Link
												href={itemScopedHref(item.id, searchParams, "historyCursor", historyPage.nextCursor)}
												scroll={false}
												className={PAGE_LINK}
											>
												Older
											</Link>
										)}
									</div>
								)}
							</Field>
						)}

						<EntityCitationLinks entityId={item.id} />

						{/* Project */}
						{item.projectId && <Field label="Project">{item.projectId}</Field>}

						{/* Branch; the PRs lead the item */}
						{item.branch && (
							<Field label="Branch">
								<code className="text-xs">{item.branch}</code>
							</Field>
						)}

						{/* Blocked by */}
						{item.blockedBy && (
							<Field label="Blocked By">
								<span className="font-mono text-destructive text-xs">
									{item.blockedBy}
								</span>
							</Field>
						)}

						{/* Labels */}
						{item.labels.length > 0 && (
							<Field label="Labels">
								<div className="flex flex-wrap gap-1.5">
									{item.labels.map((l) => (
										<span
											key={l}
											className="rounded-md bg-muted px-2 py-0.5 text-xs"
										>
											{l}
										</span>
									))}
								</div>
							</Field>
						)}

						{/* Assignees */}
						{item.assignees.length > 0 && (
							<Field label="Assignees">
								<div className="flex flex-wrap gap-2">
									{item.assignees.map((a) => (
										<span
											key={`${a.kind}-${assigneeLabel(a)}`}
											className="rounded-md bg-muted px-2 py-0.5 text-xs"
										>
											{assigneeLabel(a)}
										</span>
									))}
								</div>
							</Field>
						)}

						{/* Timestamps */}
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
