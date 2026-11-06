# goals

Node-owned Goals + KPIs presentation. The reusable measurement engine and the wire contract (`GoalsProgressSchema`, `KpiAssessmentSchema`, `MetricHistorySchema`, `MetricDisplaySchema`) live in `@cogni-dao/metrics/contracts`; this feature owns the Goals view (`components/GoalsBoard`), the open KPI chart (`components/KpiChart`) and per-type card numbers (`lib/display`).

## UI rules

- Read at a glance. The board is a three-number strip, then one card per KPI: label, number, at most one ≤3-word hint, a status pill and one mark. No sentences on the board; plain-words reasons live in the pill tooltip (`REASON_TEXT`, exhaustive by type) and on the entry page.
- Display type is the metric author's choice (`metric_spec.display`: progress, slo, volume), stored beside the spec so it never changes the series hash. Absent, `displayOf` follows the unit (ratio → progress, % → slo, else volume). progress = bar toward target; volume = gradient sparkline + change; slo = availability bars + error budget.
- `GoalsBoard` is reusable: no Knowledge-route imports. Knowledge mounts it only on `?mode=goals`; its 30s poll (`refetchIntervalInBackground: false`) runs only while that tab is selected. The entry page mounts it with `goalId` (first KPI open).
- Status comes from `assessKpi` only; the UI never re-derives it. Every status shows a symbol and a word (`STATUS_META`); color is redundant.
- Unknown is not zero: no reading is "—" (`aria-label="No reading"`), never 0; delayed and failing values are muted.
- Quiet refresh: a failed poll keeps the data silently; only `STALE_AFTER_FAILURES` consecutive failures mark it "Stale", and a 401 says "Signed out".
- Gaps stay gaps (`connectNulls={false}`); the newest reading after the last closed bucket is its own point. A young hourly metric's card draws its last 24h; the open chart opens on 1D until the series has ≥3 daily readings.
- Recharts 2 renders only its own element types as direct chart children: pass arrays, never Fragments or wrapper components. Every chart and series takes a `useChartId` id (SSR-stable). No animation.
- The open chart is a `figure` named by the metric title; a collapsed "Readings" list is the keyboard path to each observation. Operational IDs stay behind those links.

Read the canonical complete active-goal list. Never bridge missing history, invent expected values, or present stale readings as current. The UI only reads; the existing worker computes. This feature must not import bootstrap, app or adapter code. `/dev/goals-preview` renders the real board on a production snapshot (development only).
