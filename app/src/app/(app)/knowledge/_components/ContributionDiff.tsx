// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ContributionDiff`
 * Purpose: Fetches and renders the dolt_diff for one contribution: the per-row
 *   added/removed/modified entries and every changed citation edge. Shared by the
 *   slide-over `ContributionDetail` and the routable `/knowledge/inbox/[contributionId]` page.
 * Scope: Local lazy fetch of the diff; pure render otherwise.
 * Side-effects: IO (GET .../diff).
 * @internal
 */

"use client";

import {
	ContributionCitationDiff,
	KnowledgeUseWhen,
} from "@cogni/knowledge-base-ui";
import { isWorkItemEndpointId } from "@cogni/knowledge-store";
import type {
	ContributionCitationDiffEntry,
	ContributionDiffEntry,
} from "@cogni/node-contracts";
import Link from "next/link";
import { type ReactElement, useEffect, useRef, useState } from "react";

import { Markdown } from "@/components";
import { HtmlRenderer } from "./HtmlRenderer";

/** True when any diff row is an `html` entry (callers widen the layout). */
export function diffHasHtmlEntry(
	diff: ContributionDiffEntry[] | null,
): boolean {
	return (diff ?? []).some(
		(d) =>
			((d.after ?? d.before) as { entryType?: string } | null)?.entryType ===
			"html",
	);
}

/**
 * Permalink for a citation endpoint: a work item or a knowledge entry.
 * Twin of the href rule in `api/v1/citations/[id]/route.ts` (workItemPermalink).
 */
function citationHref(id: string): string {
	return isWorkItemEndpointId(id)
		? `/work/items/${encodeURIComponent(id)}`
		: `/knowledge/${encodeURIComponent(id)}`;
}

export function ContributionDiff({
	contributionId,
	onLoaded,
}: {
	readonly contributionId: string;
	/** Fired with the loaded diff so a parent can adapt layout (e.g. html width). */
	readonly onLoaded?: (diff: ContributionDiffEntry[]) => void;
}): ReactElement {
	const [diff, setDiff] = useState<ContributionDiffEntry[] | null>(null);
	const [citations, setCitations] = useState<ContributionCitationDiffEntry[]>(
		[],
	);
	const [diffError, setDiffError] = useState<string | null>(null);
	const onLoadedRef = useRef(onLoaded);
	onLoadedRef.current = onLoaded;

	useEffect(() => {
		setDiff(null);
		setCitations([]);
		setDiffError(null);
		let cancelled = false;
		fetch(
			`/api/v1/knowledge/contributions/${encodeURIComponent(contributionId)}/diff`,
			{ credentials: "same-origin", cache: "no-store" },
		)
			.then(async (r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json() as Promise<{
					entries: ContributionDiffEntry[];
					citations?: ContributionCitationDiffEntry[];
				}>;
			})
			.then((j) => {
				if (!cancelled) {
					setCitations(j.citations ?? []);
					setDiff(j.entries);
					onLoadedRef.current?.(j.entries);
				}
			})
			.catch((e: unknown) => {
				if (!cancelled)
					setDiffError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [contributionId]);

	if (diffError) return <p className="text-destructive text-xs">{diffError}</p>;
	if (!diff)
		return <p className="text-muted-foreground text-xs">Loading diff…</p>;
	if (diff.length === 0 && citations.length === 0)
		return (
			<p className="text-muted-foreground text-xs">No changes detected.</p>
		);

	return (
		<div className="flex flex-col gap-2">
			<ContributionCitationDiff
				citations={citations}
				hrefFor={citationHref}
				LinkComponent={Link}
			/>
			{diff.map((d) => {
				const row = (d.after ?? d.before) as {
					id?: string;
					title?: string;
					useWhen?: string | null;
					content?: string;
					entryType?: string;
				} | null;
				const isHtml = row?.entryType === "html";
				return (
					<div
						key={d.rowId}
						className="rounded-md border border-border/50 bg-muted/30 px-3 py-2"
					>
						<div className="flex items-center gap-2 text-xs">
							<span
								className={`inline-flex rounded-md px-1.5 py-0.5 font-mono text-xs uppercase tracking-wider ${
									d.changeType === "added"
										? "bg-success/15 text-success"
										: d.changeType === "removed"
											? "bg-destructive/15 text-destructive"
											: "bg-warning/15 text-warning"
								}`}
							>
								{d.changeType}
							</span>
							<span className="font-mono text-muted-foreground">{d.rowId}</span>
							{row?.entryType && (
								<span className="font-mono text-muted-foreground/70 text-xs">
									{row.entryType}
								</span>
							)}
						</div>
						{row?.title && (
							<p className="mt-1 line-clamp-2 font-medium text-sm">
								{String(row.title)}
							</p>
						)}
						<KnowledgeUseWhen
							useWhen={row?.useWhen}
							className="text-muted-foreground text-sm leading-relaxed [&>span]:font-medium"
						/>
						{(d.before?.metricSpec != null ||
							d.after?.metricSpec != null ||
							d.before?.kpiBindings != null ||
							d.after?.kpiBindings != null) && (
							<details className="mt-3 rounded border p-3 text-xs" open>
								<summary className="font-medium">
									Metric configuration and KPI targets
								</summary>
								<div className="mt-2 grid gap-3 md:grid-cols-2">
									{[
										["Before", d.before],
										["After", d.after],
									].map(([label, value]) => (
										<div key={String(label)}>
											<p>{String(label)}</p>
											<pre className="overflow-x-auto whitespace-pre-wrap">
												{JSON.stringify(
													value && typeof value === "object"
														? {
																metricSpec: value.metricSpec ?? null,
																kpiBindings: value.kpiBindings ?? null,
															}
														: null,
													null,
													2,
												)}
											</pre>
										</div>
									))}
								</div>
							</details>
						)}
						{isHtml && row?.content && (
							<div className="mt-2">
								<HtmlRenderer
									html={row.content}
									title={row.title ?? "preview"}
								/>
							</div>
						)}
						{!isHtml && row?.content && (
							<div className="mt-2 max-h-96 overflow-y-auto rounded bg-background/60 px-2 py-1.5">
								<Markdown content={String(row.content)} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
