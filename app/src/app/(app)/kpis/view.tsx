// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
"use client";
import type {
	MetricObservation,
	MetricView,
} from "@cogni-dao/metrics/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Details = MetricView & { history?: MetricObservation[] };
export function KpisView({
	metricId,
	observationId,
}: {
	metricId?: string;
	observationId?: string | undefined;
}) {
	const [items, setItems] = useState<Details[]>([]);
	const [pinned, setPinned] = useState<MetricObservation | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const load = useCallback(async () => {
		try {
			const response = await fetch(
				metricId
					? `/api/v1/metrics/${encodeURIComponent(metricId)}`
					: "/api/v1/metrics",
				{ cache: "no-store" },
			);
			if (!response.ok)
				throw new Error("Measurements are unavailable. Try again.");
			const body = await response.json();
			let evidence: MetricObservation | null = null;
			if (metricId && observationId) {
				const saved = await fetch(
					`/api/v1/metrics/${encodeURIComponent(metricId)}/observations/${encodeURIComponent(observationId)}`,
					{ cache: "no-store" },
				);
				if (!saved.ok)
					throw new Error("The linked observation is unavailable.");
				evidence = (await saved.json()).observation;
			}
			setPinned(evidence);
			setItems(metricId ? [body] : body.items);
			setError(null);
		} catch (e) {
			setPinned(null);
			setItems([]);
			setError(
				e instanceof Error ? e.message : "Measurements are unavailable.",
			);
		}
	}, [metricId, observationId]);
	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), 15000);
		return () => clearInterval(timer);
	}, [load]);
	async function refresh(id: string) {
		setBusy(id);
		try {
			const r = await fetch(
				`/api/v1/metrics/${encodeURIComponent(id)}/compute`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requestKey: crypto.randomUUID() }),
				},
			);
			if (!r.ok && r.status !== 409)
				throw new Error("Refresh failed. The previous evidence is preserved.");
			await load();
		} catch (e) {
			setItems([]);
			setError(e instanceof Error ? e.message : "Refresh failed.");
		} finally {
			setBusy(null);
		}
	}
	return (
		<main className="mx-auto w-full max-w-6xl space-y-8 p-6 md:p-10">
			<header className="space-y-2">
				<p className="text-sm text-muted-foreground">
					Mission → Goals → Evidence
				</p>
				<h1 className="text-3xl font-semibold">KPIs</h1>
				<p className="max-w-2xl text-muted-foreground">
					Watch open work and validated output over time. Missing or stale
					evidence stays visible.
				</p>
				{metricId && (
					<Link href="/kpis" className="text-sm underline">
						All metrics
					</Link>
				)}
			</header>
			{error && (
				<p role="alert" className="rounded border border-destructive p-4">
					{error}
				</p>
			)}
			<div className="overflow-x-auto rounded-xl border">
				<table className="w-full text-left text-sm">
					<thead className="bg-muted/40">
						<tr>
							{[
								"Metric",
								"Latest value",
								"Evidence state",
								"Source time",
								"",
							].map((h) => (
								<th key={h} className="p-4 font-medium">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{items.map((view) => {
							const r = view.latestAttempt;
							return (
								<tr key={view.definition.id} className="border-t">
									<td className="p-4">
										<Link
											href={`/kpis/${view.definition.id}`}
											className="font-medium underline underline-offset-4"
										>
											{view.definition.title}
										</Link>
										<p className="mt-1 text-xs text-muted-foreground">
											{view.definition.spec.cadenceSeconds
												? `Every ${view.definition.spec.cadenceSeconds / 60} ${view.definition.spec.cadenceSeconds === 60 ? "minute" : "minutes"}`
												: "On demand"}
										</p>
									</td>
									<td className="p-4 text-xl tabular-nums">
										{r?.value == null
											? "Unknown"
											: `${r.value} ${r.unit === "items" && r.value === 1 ? "item" : r.unit}`}
										{view.viewState !== "ok" && view.lastGood && (
											<p className="text-xs text-muted-foreground">
												Last good: {view.lastGood.value} {view.lastGood.unit}
											</p>
										)}
									</td>
									<td className="p-4">
										<span className="rounded bg-muted px-2 py-1">
											{view.viewState}
										</span>
										<p className="mt-2 text-xs text-muted-foreground">
											{r?.reason}
										</p>
									</td>
									<td className="p-4 text-xs">
										{r?.sourceWatermarks[0]?.asOf
											? new Date(r.sourceWatermarks[0].asOf).toLocaleString()
											: "Not measured"}
									</td>
									<td className="p-4">
										<button
											type="button"
											disabled={busy !== null}
											onClick={() => void refresh(view.definition.id)}
											className="rounded border px-3 py-2 disabled:opacity-50"
										>
											{busy === view.definition.id
												? "Measuring…"
												: "Measure now"}
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
				{!items.length && !error && (
					<p className="p-6 text-muted-foreground">
						No metrics configured yet.
					</p>
				)}
			</div>
			{metricId && items[0] && (
				<section className="space-y-4">
					<h2 className="text-xl font-semibold">Measurement history</h2>
					<p className="text-sm text-muted-foreground">
						Each observation keeps its definition, calculator, source time and
						evidence identity.
					</p>
					{pinned && (
						<p className="text-sm">
							Linked immutable evidence. Its definition may differ from the
							current metric.
						</p>
					)}
					{[
						...(pinned ? [pinned] : []),
						...(items[0].history ?? []).filter((r) => r.id !== pinned?.id),
					].map((r) => (
						<article
							id={`observation-${r.id}`}
							key={r.id}
							className="space-y-2 rounded-lg border p-4 text-sm"
						>
							<div className="flex flex-wrap justify-between gap-3">
								<strong>
									{r.value ?? "Unknown"} {r.unit} · {r.status}
								</strong>
								<time>{r.window.end}</time>
							</div>
							<p className="break-all text-xs text-muted-foreground">
								Observation {r.id}
							</p>
							<p className="break-all text-xs text-muted-foreground">
								Definition {r.definitionHash} · Calculator {r.calculatorVersion}
							</p>
							<p className="text-xs">
								{r.reason ?? r.evidenceRefs.join(" · ")}
							</p>
						</article>
					))}
				</section>
			)}
		</main>
	);
}
