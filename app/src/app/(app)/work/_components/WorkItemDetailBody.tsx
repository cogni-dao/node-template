// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkItemDetailBody`
 * Purpose: Helps a human decide what the item is, whether its latest review lets it move, and why it moved.
 * Scope: Presentation of one item read. The Artifacts and History fields render page 1 of refs from the item read and an
 *   older page from the refs views; the selected artifact comes from the item read's `artifact` (story.0058).
 * Invariants:
 *   - EXISTING_PARTS_ONLY: Field, Link, Markdown and RelativeTime; no new component (hub work-item-artifacts, Item page).
 *   - SECTIONS_NEED_THEIR_PARTS: Artifacts and History render only when the item read carries them.
 *   - ITEM_SCOPED_URL: `artifact`, `artifactsCursor` and `historyCursor` belong to this item; links set them with scroll off.
 * Side-effects: IO (older ref pages, only when a cursor parameter is set)
 * Links: hub work-item-artifacts, change-history-design, ../_lib/workItemNavigation.ts
 * @internal
 */

"use client";

import {
	hasScores,
	RelativeTime,
	WorkItemScoresRadar,
	WorkExpectations,
	type WorkMetric,
} from "@cogni/knowledge-base-ui";
import { WorkMoveLinks } from "@cogni/knowledge-base-ui/goals";
import type { WorkItemDto, WorkItemsGetOutput } from "@cogni/node-contracts";
import { type ArtifactKind, scorecardMarkdown } from "@cogni/work-items";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/sheet";
import type { ReactElement } from "react";
import { Markdown } from "@/components/markdown";

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
};

/** An artifact's human title: its kind and verdict, e.g. "Design review · request changes". */
function artifactTitle(ref: { readonly kind: ArtifactKind; readonly verdict: string }): string {
	return `${KIND_TITLES[ref.kind]} · ${ref.verdict.replace(/_/g, " ")}`;
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
	const selected = read?.artifact;

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
						<WorkMoveLinks
							moves={item.moves ?? NO_MOVES}
							labels={item.labels}
							LinkComponent={PeekLink}
						/>
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

						{/* Artifacts: the reviews and validations that let the item move (story.0058) */}
						{read?.artifactRefs !== undefined && (
							<Field label="Artifacts">
								{artifactsLoading ? (
									<span className="text-muted-foreground">Loading reviews</span>
								) : artifactsUnavailable ? (
									<span className="text-muted-foreground">Reviews are unavailable</span>
								) : !artifactPage?.refs.length ? (
									<span className="text-muted-foreground">No reviews yet</span>
								) : (
									<div className="flex flex-col gap-1">
										{artifactPage.refs.map((ref) => (
											<Link
												key={ref.id}
												href={itemScopedHref(item.id, searchParams, "artifact", ref.id)}
												scroll={false}
												className={`${ROW} min-h-6 hover:underline`}
												aria-current={selected && "id" in selected && selected.id === ref.id ? "true" : undefined}
											>
												<span className={ROW_TITLE}>{artifactTitle(ref)}</span>
												<RelativeTime iso={ref.createdAt} className={ROW_TIME} />
											</Link>
										))}
									</div>
								)}
								{(artifactPage?.nextCursor != null || artifactsCursor !== null) && (
									<div className="mt-1 flex gap-3">
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
							</Field>
						)}

						{/* The selected artifact in full */}
						{selected !== undefined && (
							<Field label="Artifact">
								{"notFound" in selected ? (
									<span className="text-muted-foreground">Artifact not found</span>
								) : "unavailable" in selected ? (
									<span className="text-muted-foreground">The artifact is unavailable</span>
								) : (
									<div className="flex flex-col gap-2">
										<div className={ROW}>
											<span className={`${ROW_TITLE} font-medium`}>{artifactTitle(selected)}</span>
											<RelativeTime iso={selected.createdAt} className={ROW_TIME} />
										</div>
										{selected.note && <span className="text-muted-foreground">{selected.note}</span>}
										{selected.body ? (
											<Markdown content={selected.body} />
										) : selected.rows?.length ? (
											<Markdown content={scorecardMarkdown(selected.rows)} />
										) : selected.url ? (
											<Link href={selected.url} className="underline" target="_blank" rel="noreferrer">
												{selected.url}
											</Link>
										) : null}
									</div>
								)}
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
										{historyPage.refs.map((ref) => (
											<div key={ref.commit} className={ROW}>
												<span className={ROW_TITLE}>{ref.reason ?? "No reason recorded"}</span>
												<RelativeTime iso={ref.at} className={ROW_TIME} />
											</div>
										))}
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

						{/* Branch / PR */}
						{(item.branch || item.pr) && (
							<div className="flex gap-6">
								{item.branch && (
									<Field label="Branch">
										<code className="text-xs">{item.branch}</code>
									</Field>
								)}
								{item.pr && (
									<Field label="PR">
										<code className="text-xs">{item.pr}</code>
									</Field>
								)}
							</div>
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

						{/* Spec refs */}
						{item.specRefs.length > 0 && (
							<Field label="Spec Refs">
								<div className="flex flex-col gap-1">
									{item.specRefs.map((s) => (
										<code key={s} className="text-xs">
											{s}
										</code>
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
