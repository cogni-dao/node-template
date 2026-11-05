# goals

Node-owned Goals + KPIs presentation. The reusable measurement engine and the wire contract (`GoalsProgressSchema`, `KpiAssessmentSchema`, `MetricHistorySchema`) live in `@cogni-dao/metrics/contracts`; this feature owns product composition, the read-only goal/EDO projection (`services/`), and the Goals view (`components/GoalsBoard`).

## UI rules

- `GoalsBoard` is reusable: no Knowledge-route imports. Knowledge mounts it only on `?mode=goals`, so its 30s poll (`refetchIntervalInBackground: false`) runs only while that tab is selected. The entry page mounts it with `goalId`.
- Status comes from `assessKpi` only. The UI never re-derives it, and never lets the chart range change it. Every status shows a symbol and a word (`lib/presentation.ts` `STATUS_META`); color is redundant. Every `KpiReason` maps to one plain sentence in `REASON_TEXT`, and the type system enforces that the map is exhaustive.
- Unknown is not zero. A missing reading says so; delayed and failing values are shown muted and labeled "last good". After a failed refresh, the board keeps the last data and labels it "not current" under one `role="alert"`.
- Gaps stay gaps. Sparklines and the history chart break at every non-ok bucket (`connectNulls={false}`). The newest reading after the last closed bucket is plotted as its own point, never carried into a bucket.
- Every SVG chart has `role="img"` and an aria-label that states the values, the target and any gaps. Numbers use `tabular-nums`. Operational IDs stay behind the "Inspect reading" link.

Read the canonical complete active-goal list. Do not introduce goal limits or infer EDO outcomes from thresholds. Predictions keep fixed baselines and deadlines. Never bridge missing history, compare changed definitions, invent expected values, or present stale readings as current. The UI only reads; the existing worker computes. This feature must not import bootstrap, app or adapter code.
