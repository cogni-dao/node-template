// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { metricTrace, requiredPace } from "../lib/metric-trend";
import {
	type GoalProgress,
	type GoalsProgressData,
	GoalsProgressSchema,
} from "../types";

const number = (value: number) =>
	new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
const date = (value: string) =>
	`${new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	}).format(new Date(value))} UTC`;
const compare = (value: string) =>
	value === "gte" ? "≥" : value === "lte" ? "≤" : "=";
function duration(ms: number) {
	const minutes = Math.max(1, Math.round(ms / 60000));
	return minutes < 60
		? `${minutes}m`
		: minutes < 1440
			? `${Math.round(minutes / 60)}h`
			: `${Math.round(minutes / 1440)}d`;
}
function evaluation(at: string | null, now: number) {
	return !at
		? "Evaluation not scheduled"
		: Date.parse(at) <= now
			? "Evaluation due"
			: `Evaluate in ${duration(Date.parse(at) - now)}`;
}
async function fetchProgress() {
	const response = await fetch("/api/v1/metrics/goals", { cache: "no-store" });
	if (!response.ok)
		throw new Error("Goals and measurements are temporarily unavailable.");
	return GoalsProgressSchema.parse(await response.json());
}
export function GoalsProgress({
	initialData,
	goalId,
}: {
	initialData?: GoalsProgressData | undefined;
	goalId?: string | undefined;
}) {
	const query = useQuery({
		queryKey: ["goals", "progress"],
		queryFn: fetchProgress,
		initialData,
		refetchInterval: 15000,
		staleTime: 10000,
		retry: 1,
	});
	const data = query.data;
	const now = data ? Date.parse(data.asOf) : 0;
	return (
		<section
			aria-label="Node goals and KPIs"
			className="space-y-3 rounded-xl border border-border/70 bg-card/30 p-4 md:p-5"
		>
			<header className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="font-semibold text-base">Goals & KPIs</h2>
				<span className="text-muted-foreground text-xs">
					{data?.environment === "local" ? "Local demo · " : ""}Measured
					automatically · evidence drives the next decision
				</span>
			</header>
			{query.isError ? (
				<p role="alert" className="text-sm text-amber-500">
					Goal evidence is unavailable. Previous readings are not current.
				</p>
			) : !data ? (
				<p className="animate-pulse text-muted-foreground text-sm">
					Loading goals and evidence…
				</p>
			) : !data.goals.length ? (
				<p className="text-muted-foreground text-sm">No approved goals yet.</p>
			) : (
				<div className="divide-y divide-border/60">
					{data.goals
						.filter((goal) => !goalId || goal.id === goalId)
						.map((goal) => (
							<article
								key={goal.id}
								className="space-y-3 py-4 first:pt-1 last:pb-0"
								aria-label={goal.title}
							>
								<div className="flex items-baseline justify-between gap-4">
									<Link
										href={`/knowledge/${goal.id}`}
										className="font-medium text-sm hover:underline"
									>
										{goal.title.replace(/^Goal:\s*/, "")}
									</Link>
									{goal.evaluateAt && (
										<span
											className="shrink-0 text-muted-foreground text-xs"
											title={date(goal.evaluateAt)}
										>
											By {new Date(goal.evaluateAt).toISOString().slice(0, 10)}
										</span>
									)}
								</div>
								{goal.metrics.length ? (
									<div className="grid gap-3 md:grid-cols-2">
										{goal.metrics.map((metric) => (
											<Metric
												key={JSON.stringify(metric.binding)}
												metric={metric}
												deadline={goal.evaluateAt}
												now={now}
											/>
										))}
									</div>
								) : (
									<p className="text-muted-foreground text-xs">
										{goal.configurationError
											? "Measurement configuration needs review."
											: "Automatic evidence not connected yet."}
									</p>
								)}
								{!!goal.hypotheses.length && (
									<section
										className="space-y-2 border-l-2 border-border pl-3"
										aria-label="Hypotheses and predictions"
									>
										{goal.hypotheses.map((bet) => (
											<div key={bet.id} className="space-y-1 text-xs">
												<div className="flex flex-wrap items-center justify-between gap-2">
													<Link
														href={`/knowledge/${bet.id}`}
														className="font-medium hover:underline"
													>
														Hypothesis · {bet.title}
													</Link>
													<span
														className="text-muted-foreground"
														title={
															bet.evaluateAt ? date(bet.evaluateAt) : undefined
														}
													>
														{bet.outcome ? (
															<Link
																href={`/knowledge/${bet.outcome.id}`}
																className="underline"
															>
																{bet.outcome.supports
																	? "Supported by recorded outcome"
																	: "Contradicted by recorded outcome"}
															</Link>
														) : (
															evaluation(bet.evaluateAt, now)
														)}
													</span>
												</div>
												{bet.predictions.length ? (
													bet.predictions.map((p) => (
														<p
															key={JSON.stringify([
																p.metricId,
																p.comparator,
																p.target,
																p.evaluationAt,
																p.baselineObservationId,
															])}
															className="text-muted-foreground"
														>
															Expected {compare(p.comparator)}{" "}
															{number(p.target.value)} {p.target.unit}
															{p.evaluationAt
																? ` by ${date(p.evaluationAt)}`
																: ""}
															{" · "}
															{p.baseline
																? `baseline ${number(p.baseline.value ?? 0)} → `
																: ""}
															{p.observation && p.viewState === "ok" ? (
																<Link
																	className="underline"
																	href={`/knowledge/${p.metricId}?observation=${p.observation.id}`}
																>
																	{p.evaluationAt
																		? "Evaluation reading"
																		: "Observed"}{" "}
																	{number(p.observation.value ?? 0)}{" "}
																	{p.observation.unit}
																</Link>
															) : (
																"Awaiting comparable evidence"
															)}
															{p.met !== null && !bet.outcome
																? " · threshold comparison ready; agent evaluation pending"
																: ""}
														</p>
													))
												) : (
													<p className="text-muted-foreground">
														Prediction not connected to a metric.
													</p>
												)}
											</div>
										))}
									</section>
								)}
								{goal.hypothesesUnavailable && (
									<p className="text-amber-500 text-xs">
										Hypothesis evidence is temporarily unavailable.
									</p>
								)}
								{goal.moreHypotheses && (
									<Link
										href={`/knowledge/${goal.id}`}
										className="text-muted-foreground text-xs underline"
									>
										More linked hypotheses
									</Link>
								)}
							</article>
						))}
				</div>
			)}
		</section>
	);
}
function Metric({
	metric,
	deadline,
	now,
}: {
	metric: GoalProgress["metrics"][number];
	deadline: string | null;
	now: number;
}) {
	const { view, binding, reading } = metric;
	const fixedEvaluation = !!binding.evaluationAt;
	const current = fixedEvaluation ? reading.observation : view?.latestAttempt;
	const state = fixedEvaluation ? reading.viewState : view?.viewState;
	const ongoing = view?.latestAttempt;
	const ongoingFresh =
		view?.viewState === "ok" &&
		ongoing?.value !== null &&
		ongoing?.value !== undefined &&
		ongoing.unit === binding.target.unit;
	const fresh =
		state === "ok" &&
		current?.value !== null &&
		current?.value !== undefined &&
		current?.unit === binding.target.unit;
	const trace = metricTrace(
		metric.history,
		Math.max(
			view?.definition.spec.maxAgeSeconds ?? 0,
			(view?.definition.spec.cadenceSeconds ?? 60) * 2,
		) * 1000,
		(view?.definition.spec.maxAgeSeconds ?? 0) * 1000,
	);
	const end = binding.evaluationAt ?? deadline;
	const needed =
		ongoingFresh && ongoing
			? requiredPace(
					ongoing.value as number,
					binding.target.value,
					end,
					now,
					trace.unitMs,
				)
			: null;
	const onTarget = fixedEvaluation
		? reading.met === true
		: fresh &&
			current &&
			(binding.comparator === "gte"
				? (current.value ?? NaN) >= binding.target.value
				: binding.comparator === "lte"
					? (current.value ?? NaN) <= binding.target.value
					: current.value === binding.target.value);
	const slope = trace.rate;
	const improved =
		slope !== null &&
		(binding.comparator === "gte"
			? slope > 0
			: binding.comparator === "lte"
				? slope < 0
				: false);
	return (
		<div
			className="rounded-lg bg-muted/25 px-3 py-2.5"
			data-metric={binding.metricId}
		>
			<div className="flex items-baseline justify-between gap-3">
				<Link
					href={`/knowledge/${binding.metricId}`}
					className="text-muted-foreground text-xs hover:underline"
				>
					{view?.definition.title ?? binding.metricId}
				</Link>
				<span className="font-medium text-lg tabular-nums" data-current-value>
					{fresh ? `${number(current.value as number)} ${current.unit}` : "—"}
				</span>
			</div>
			{fixedEvaluation && reading.reason === "evaluation_not_due" && (
				<p className="text-muted-foreground text-xs">Evaluation not due</p>
			)}
			<div className="my-1">
				{fixedEvaluation && (
					<p className="text-muted-foreground text-xs">Ongoing measurements</p>
				)}
				<Trace
					trace={trace}
					target={binding.target.value}
					title={view?.definition.title ?? binding.metricId}
				/>
			</div>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
				<span className="text-muted-foreground">
					Target {compare(binding.comparator)} {number(binding.target.value)}{" "}
					{binding.target.unit}
				</span>
				<span
					className={
						ongoingFresh && improved
							? "text-emerald-500"
							: "text-muted-foreground"
					}
				>
					{!ongoingFresh
						? view?.viewState === "stale"
							? "Measurement delayed"
							: view?.viewState === "pending"
								? "Updating automatically"
								: "Evidence unavailable"
						: slope === null
							? "Building trend"
							: `${fixedEvaluation ? "Ongoing: " : ""}${slope > 0 ? "+" : ""}${number(slope)} ${view?.latestAttempt?.unit ?? binding.target.unit}/${trace.rateUnit} · ${duration(trace.span)} observed`}
				</span>
			</div>
			<details className="mt-1.5 text-muted-foreground text-xs">
				<summary className="cursor-pointer select-none">
					{onTarget
						? "At target"
						: end
							? evaluation(end, now)
							: "Evidence & schedule"}
				</summary>
				<div className="mt-2 space-y-1 border-t border-border/50 pt-2">
					{end && <p>Goal evaluation: {date(end)}</p>}
					{needed !== null && !onTarget && (
						<p>
							Needed average pace: {number(needed)} {binding.target.unit}/
							{trace.rateUnit}. This is a target pace, not a forecast.
						</p>
					)}
					<p>
						{view?.definition.spec.cadenceSeconds
							? `Measures automatically every ${duration(view.definition.spec.cadenceSeconds * 1000)}.`
							: "No automatic measurement schedule configured."}
					</p>
					{current && (
						<p>
							{fixedEvaluation ? "Evaluation reading" : "Last attempt"}:{" "}
							{date(current.window.end)} · {state}
						</p>
					)}
					{current && (
						<Link
							className="block underline"
							href={`/knowledge/${binding.metricId}?observation=${current.id}`}
						>
							Inspect measurement evidence
						</Link>
					)}
					<p>Observed changes do not establish which action caused them.</p>
				</div>
			</details>
		</div>
	);
}
function Trace({
	trace,
	target,
	title,
}: {
	trace: ReturnType<typeof metricTrace>;
	target: number;
	title: string;
}) {
	const points = trace.segments.flat();
	if (!points.length)
		return (
			<div
				className="h-12 border-b border-dashed border-border/60"
				role="img"
				aria-label={`${title}: no measurements yet`}
			/>
		);
	const first = points[0]?.at ?? 0,
		last = points.at(-1)?.at ?? first;
	const lo = Math.min(target, ...points.map((p) => p.value)),
		hi = Math.max(target, ...points.map((p) => p.value));
	const x = (t: number) =>
		6 + (last === first ? 0 : (t - first) / (last - first)) * 388;
	const y = (v: number) => 40 - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * 32;
	return (
		<svg
			viewBox="0 0 400 48"
			className="h-12 w-full overflow-visible"
			role="img"
			aria-label={`${title}: ${points.length} observed readings; dashed line is the target`}
		>
			<title>{`${title} · ${date(new Date(first).toISOString())} to ${date(new Date(last).toISOString())}; gaps are unobserved.`}</title>
			<line
				x1="6"
				x2="394"
				y1={y(target)}
				y2={y(target)}
				stroke="currentColor"
				strokeDasharray="3 4"
				className="text-muted-foreground/40"
			/>
			{trace.segments.map((segment, i) => (
				<polyline
					key={segment[0]?.id ?? i}
					points={segment.map((p) => `${x(p.at)},${y(p.value)}`).join(" ")}
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					className="text-foreground/70"
				/>
			))}
			{points.map((p) => (
				<circle
					key={p.id}
					cx={x(p.at)}
					cy={y(p.value)}
					r="2"
					className="fill-foreground/70"
				>
					<title>{`${number(p.value)} · ${date(new Date(p.at).toISOString())}`}</title>
				</circle>
			))}
		</svg>
	);
}
