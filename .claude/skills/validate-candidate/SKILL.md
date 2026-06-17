---
name: validate-candidate
description: Close the deploy_verified loop for THIS node after a PR is flighted to its candidate deploy. Confirm the candidate build matches the PR head SHA via /version, enumerate impacted surfaces (API routes, UI pages, graphs), exercise each against the real deployed URL on both the human (Playwright) and agent (API) axes, query Loki for your own request when creds are available, then post an approve/fail scorecard as a PR comment. Use whenever the user says "validate the candidate deploy", "prove this PR on candidate", "close the deploy_verified loop", or runs "/validate-candidate" (with or without a PR number). NOT for pre-merge CI or local dev testing — this runs after the operator has flighted the PR.
---

# /validate-candidate — Manual E2E Validation (single-node fork)

This is the node-author version of the lifecycle Definition of Done step 5: a PR that
flighted green only proves it *builds and deploys*. It does **not** prove the feature
works for a real request hitting the real deployed URL. This skill drives the changed
surface on the live candidate build and reads its own request back out — then posts a
scorecard. The posted scorecard IS the validation signal.

> This node is a **single flat-layout app** (`app/` at repo root), deployed as one node
> to its own candidate subdomain. There is no multi-node URL map and no `nodes/<node>/`
> tree — if you came from the operator monorepo's validate-candidate, that shape does
> not apply here.

## Hard rules (read first, do not violate)

1. **Zero artifacts.** This skill writes *nothing* to disk during a run. No per-PR
   scripts, no scorecard files, no screenshots, no temp JSON. Inline everything.
   Playwright via `playwright-cli` (session-scoped, ephemeral). The scorecard is held in
   a shell variable and piped straight into `gh pr comment --body-file -`.
2. **Discovery is not execution.** Running a *listing* endpoint to confirm a graph/tool
   is registered does NOT earn the agent-axis pass. The agent axis is 🟢 only when you
   actually invoked the capability and got a successful response. "The catalog contains
   it" is 🟡 at best, labeled as such.
3. **Observability must tie to the feature exercise, not ambient traffic.** A generic
   `request received` log for a listing endpoint is not proof your feature worked. Query
   for the feature-specific marker (the route handler's emit, the graph-run line). "Found
   traffic at the SHA" without the feature marker is 🟡, not 🟢.

## When you're invoked

- `/validate-candidate` (use the current branch's PR) · `/validate-candidate 12` · "prove
  PR #12 on candidate".
- No PR number → resolve with `gh pr view --json number -q .number`. If that fails (not
  on a PR branch), stop and ask.
- **Dry-run:** if `VALIDATE_CANDIDATE_DRY_RUN=1` or the user says "dry run" / "don't post",
  do everything through scorecard assembly but print the markdown to stdout instead of
  commenting. Always state in the final output whether the PR was commented on.

## Prerequisites — check up front, halt on the first two only

1. **`gh` authed** — `gh auth status` green. Stop if not.
2. **The PR was flighted and is green** (see Step 2). If not, halt — don't poll.
3. **Captured auth state for the human axis** — a `.local-auth/candidate-<slug>.storageState.json`
   session. If absent, do NOT halt: run the agent axis + buildSha + Loki, and mark the
   human axis `skipped (no captured session)`. Capturing a session is an interactive
   login (out of scope for an autonomous run); a fresh fork often has none yet.
4. **Loki access is best-effort.** If `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` are
   in env / `.env.cogni`, use them. If not, mark every observability cell
   `no-grafana-data-available` and proceed — the missing-observability gap is itself a
   finding worth reporting, never a reason to halt.

## The flow

### Step 1 — Load PR context
```bash
gh pr view <N> --json number,title,headRefOid,headRefName,body,files,state,statusCheckRollup
```
Capture: head SHA, changed files, branch, check rollup.

### Step 2 — Confirm flight state
From the rollup, the flight/deploy check for the PR head SHA must be `SUCCESS`. If it's
in-progress / pending / missing / failed, **halt and report** — "flight isn't green yet,
re-invoke me when it is." Don't wait, don't retry.

### Step 3 — Resolve this node's candidate URL + classify changed files
The node slug is `intent.name` in `.cogni/repo-spec.yaml`. The candidate URL is
`https://<slug>-test.cognidao.org` (confirm against the operator's flight output if
unsure). Group changed files into surface types — flat layout:

| Path glob                                  | Surface type |
| ------------------------------------------ | ------------ |
| `app/src/app/api/**/route.ts`              | `api-route`  |
| `app/src/app/**/page.tsx`, `view.tsx`      | `ui-page`    |
| `app/src/**/graphs/**`, graph registration | `graph`      |
| `packages/db-schema/**`, `migrations/**`   | `db`         |
| `infra/**`, `.github/workflows/**`         | `infra`      |
| `docs/**`, `work/**`, `*.md`               | `docs`       |
| `.claude/**`, `scripts/**`, root configs   | `tooling`    |
| everything else                            | `other`      |

Build an **impact matrix**: one row per distinct (surface type × concrete target) — a UI
route (`/credits`), an API method+path, a graph name.

### The two axes — Human and Agent
Every *behavioral* feature lives on both axes; try both:
- **Human** — drive the UI with `playwright-cli` + captured storageState. "Does clicking
  through the product do the thing?"
- **Agent** — call the route/graph directly via API key / service token / session cookie.
  "Does the capability exist on the deployed build?"

The disagreement is the most useful finding:

| Agent | Human | Meaning |
| ----- | ----- | ------- |
| 🟢 | 🟢 | Works end-to-end. Rarest, best signal. |
| 🟢 | 🔴 | **Drift** — backend shipped, UI didn't. Real bug; flag it. |
| 🔴 | 🟢 | UI is lying (fake success / stale cache). Higher severity. |
| 🔴 | 🔴 | Deploy broken. Halt-worthy. |
| 🟢 | n/a | Backend-only change, no UI surface. Expected for many PRs. |
| n/a | 🟢 | UI-only change (copy/style). Expected for frontend PRs. |

Each row carries two verdict cells (Human · Agent) plus a Loki cell.

### Step 4 — Confirm buildSha matches PR head
```bash
curl -sf https://<slug>-test.cognidao.org/version | jq -r .buildSha
```
Prefix-compare to the PR head SHA. Mismatch → halt and report: the candidate is serving a
different build than the PR. The user re-flights or waits.

### Step 5 — Exercise each row on both axes
**Agent axis:**
- `api-route` — call it with an API key / service token; if it needs a user session,
  extract the session cookie from `.local-auth/candidate-<slug>.storageState.json` and pass
  as a `Cookie:` header to `curl`/`fetch`.
- `graph` — **EXECUTE, don't list.** Find the invocation route (commonly
  `POST /api/v1/agent/runs` or the node's chat route), POST a run selecting the graph by
  its registered id with a minimal realistic input, and read enough of the response/stream
  to confirm it ran. A `GET .../agents` listing is discovery — secondary evidence only.
- tool registration — discovery only → 🟡 unless you invoke it end-to-end via a graph.

**Human axis** — `playwright-cli` (one bash call per action; snapshots give a11y refs):
```bash
playwright-cli -s=validate state-load .local-auth/candidate-<slug>.storageState.json
playwright-cli -s=validate open https://<slug>-test.cognidao.org/<route>
playwright-cli -s=validate snapshot      # element refs
playwright-cli -s=validate click e<N>    # exercise the change
playwright-cli -s=validate snapshot      # verify outcome
playwright-cli -s=validate network       # downstream API call fired?
playwright-cli -s=validate console       # client-side errors
playwright-cli -s=validate close
```
For a graph/tool behind the UI: open the chat page, open the graph picker, re-snapshot. If
the new graph's displayName is absent → row is 🔴 **drift** ("registered backend-side, not
exposed in chat UI"). `.playwright-cli/` is its own working state — gitignore it, never
cite its files in the scorecard.

**Skip an axis** only when it genuinely doesn't apply (record `n/a` + reason) or you can't
figure out how to exercise it (record `skipped` + reason, ding the verdict toward 🟡).
Record per exercised axis: UTC start time, observed HTTP status / visible assertion, verdict.

**One row can hide a family.** If the PR adds ≥3 surfaces of the same shape (a
`/api/v1/<resource>/*` cluster, a tool cluster), exercise each member — a 🟢 row that
probed only one member silently passes the rest. Put the per-member sweep in a second PR
comment; if it surfaces a 🔴 the headline run missed, the headline verdict drops to 🔴.

### Step 6 — Observability: find the feature-specific log of your own call
Only if Loki creds are available (else mark `no-grafana-data-available`). Window:
`start = exercise_start − 10s`, `end = now + 10s`. Tier the query; stop at the first tier
that returns ≥1 line:
1. **Feature-specific marker** (the route handler's emit / the graph-run line — inspect
   `app/src` for the actual emitter). **🟢 only at this tier.**
2. **reqId/traceId correlation** — query `|~ "<reqId>"` from a captured response header.
   Proves your specific call hit the pod.
3. **userId + route**, narrowed to the window → 🟡 (traffic from you, not proven feature).
4. **Ambient route traffic** only → 🟡 with a note.

Query via `mcp__grafana__query_loki_logs` (datasource uid `grafanacloud-logs`) when
connected, or a direct Loki HTTP call with the env token. Labels are the node's own
candidate namespace + `pod=~"<slug>-node-app-.*"` plus JSON fields `reqId`, `route`, `msg`.
If only tier 4 matches, the cell is 🟡 — never grant 🟢 to generic traffic.

### Step 7 — Post the scorecard (zero artifacts)
Build the markdown in memory; post via stdin: `echo "$SCORECARD_MD" | gh pr comment <N> --body-file -`.
Never write it to a file (incl. `/tmp`). Dry-run prints to stdout and stops.

### Exact scorecard format — DO NOT deviate
This shape is locked; the maintainer reads the terminal paste directly. Cell widths,
emoji-only state columns, and the fenced evidence block are load-bearing.

````markdown
## /validate-candidate — PR #<N> · `<sha-short>` · <🔴 FAIL | 🟡 NOTES | 🟢 PASS>

| PR TWEAK          | HUMAN | AI  | LOKI | OVERALL     |
| ----------------- | ----- | --- | ---- | ----------- |
| <TWEAK-NAME-CAPS> | 🔴    | 🔴  | 🟢   | 🔴 FAIL     |
| <TWEAK-NAME-CAPS> | —     | 🔴  | 🟢   | 🔴 DRIFT    |
| <TWEAK-NAME-CAPS> | —     | 🟡  | 🟡   | 🟡 INDIRECT |
| <TWEAK-NAME-CAPS> | —     | 🟡  | 🟡   | 🟡 UNPROVEN |
| <TWEAK-NAME-CAPS> | —     | —   | —    | ⚪ N/A      |

EVIDENCE

```
    pod  <pod-name>  ·  sha <sha-short>
    ────────────────────────────────────────────────────────────
    <one exercise per line, padded for column alignment>
    <e.g.  POST /chat  graphName="foo"   → 404   reqId abc12345>
```

NOTES <one line, dot-separated — caveats, pre-existing issues, flight-status notes>
````

Rules that hold every invocation:
1. **Rows are "PR tweaks"** — the concrete surfaces this PR introduces/modifies. n/a rows
   last. A docs-only PR may have a single n/a row.
2. **Four emoji columns — HUMAN · AI · LOKI · OVERALL.** Single emoji or `—`. HUMAN =
   Playwright. AI = API/agent exercise. LOKI = tier-1 only (else 🟡). OVERALL gets one CAPS
   label (FAIL / DRIFT / INDIRECT / UNPROVEN / PASS / N/A).
3. **Evidence in the fenced block below the table, never in cells** — one padded line per
   exercise: `METHOD  path  detail  → status  reqId-or-marker`.
4. **NOTES is one line, dot-separated.** More than one line = split into a second pass.

Verdict in the heading: `🔴 FAIL` if any row OVERALL is 🔴 · `🟡 NOTES` if no reds but any
🟡 · `🟢 PASS` only when every non-n/a row is 🟢 across all axes (rare).

## Verdict rules
Per row: both axes 🟢 → 🟢 · one 🟢 + other 🔴 → 🔴 (the disagreement IS the finding) ·
one 🟢 + other n/a → 🟢 · skipped axis → 🟡. Overall: 🟢 approve only when every non-n/a
row is 🟢 *and* every exercised axis has 🟢 observability; 🟡 approve-with-notes when
exercises pass but something's soft (observability partial/missing, an axis skipped, no
captured auth); 🔴 fail on any row 🔴, buildSha mismatch, or flight-not-green. **Err 🟡
when in doubt — never give 🟢 to something you couldn't observe.**

## What this skill deliberately does NOT do
- **No work-item frontmatter edits.** `deploy_verified: true` is noise — the PR comment is
  the signal.
- **No retrying** a failed flight or stale build. Report and stop; the user decides.
- **No interactive auth.** Captured storageState only; if missing, skip the human axis.
- **No synthesizing observability.** If you didn't see it in Loki, say so.

## Cost discipline
UI exercises are a single headless pageview; API exercises are single HTTP calls; scope
Loki by namespace + SHA. If a row needs >~30s of automation you're over-engineering —
reduce to the minimum sequence that would fail if the PR were broken.

## If you get stuck
- Can't classify a file → mark `other`/skipped with reason, move on.
- Playwright can't find an element → capture visible text + button list into notes, mark 🟡.
- API returns 5xx → 🔴 for that row; include the truncated response body.
- storageState rejected (redirect to signin) → cookie expired; skip the human axis for now,
  note the refresh need, continue with agent-axis rows.
- The node's pod/URL is missing on candidate → that's a flight/deploy problem for the
  operator, not a validation finding you can fix here; report it and stop.
