---
id: guide.recurring-schedules
type: guide
title: Recurring Schedules
status: draft
trust: draft
summary: Declare cron-recurring work in your node's repo-spec; the operator reconciles it into a Temporal schedule and triggers it under your node's tenant identity — the node writes zero Temporal code.
read_when: Adding recurring work (periodic graph runs or periodic POSTs to your own ops route) to a node.
owner: derekg1729
created: 2026-06-17
verified: null
tags: [infra, temporal, schedules, nodes]
---

# Recurring Schedules

A node declares recurring work as data in its own `.cogni/repo-spec.yaml`. The
operator reconciles that declaration into a Temporal schedule and triggers each
run **under your node's tenant identity**. The node writes **zero Temporal code**:
no Workflow, no Activity, no schedule CRUD call.

> Source contract: operator design `design.node-temporal-tenant-interface`
> (story.5008, T3). This guide is the node-author half.

## How it runs

- **Operator = trigger.** It owns the Temporal backend, reconciles your
  `schedules:` block at provision/flight, and fires each run on schedule.
- **Node = executor, under its own identity.** A `graph:` schedule runs your
  node's LangGraph executor; a `route:` schedule POSTs to your node's own
  token-gated route. Either way the run carries your node's tenant principal,
  not the operator's.
- The Temporal backend is operator-managed but **swappable** — a sovereign node
  can self-host Temporal behind this same declarative contract.

Reconciliation is **system-ops only** (provision/flight). There is no
node-callable "create a schedule" API; you change the declaration in git and it
takes effect on the next flight.

## The `schedules:` block

Add a top-level `schedules:` list to `.cogni/repo-spec.yaml`. Each entry:

```yaml
# .cogni/repo-spec.yaml
schedules:
  - id: metrics-ingest            # stable id → workflowId/scheduleId
    cron: "*/15 * * * *"
    timezone: UTC
    # EXACTLY ONE of `graph` or `route`. The operator infers the workflow type
    # from which one is present. There is NO `target` field.
    graph: my-graph-id            # graph schedule — runs the node's LangGraph executor
    # route: /api/internal/ops/metrics-ingest   # http-dispatch — POSTs to the node's OWN route
    payload: { window: "15m" }    # opaque to the operator; your graph/route owns its meaning
    overlap: skip                 # platform default
    catchupWindow: 0s             # platform default
```

| Field           | Meaning                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `id`            | Stable identifier. Drives the derived `workflowId` / `scheduleId`. Renaming it creates a new schedule. |
| `cron`          | 5-field cron expression (minute hour day month weekday).                                          |
| `timezone`      | IANA timezone. Defaults to `UTC`.                                                                  |
| `graph`         | A graph id from this node's runtime catalog. Mutually exclusive with `route`.                     |
| `route`         | A **node-relative** path (`/...`) the operator POSTs to. Mutually exclusive with `graph`.          |
| `payload`       | Opaque JSON. The operator passes it through verbatim; your graph/route defines its meaning.        |
| `overlap`       | `skip` (platform default) — one run per schedule at a time; a slot is skipped if the prior run is still going. |
| `catchupWindow` | `0s` (platform default) — missed slots are not backfilled.                                         |

Provide **exactly one** of `graph` or `route`. The operator infers whether this
is a graph run or an http-dispatch from which key is present.

## `graph:` schedules — available today

Graph execution is proven live end-to-end, so `graph:` schedules work **today**.
This is the recommended path.

```yaml
schedules:
  - id: nightly-digest
    cron: "0 6 * * *"
    timezone: UTC
    graph: ponderer            # any graph id this node exposes (see Agent Development guide)
    payload: { topic: "daily-summary" }
```

On each fire the operator runs the named graph through your node's LangGraph
executor, under your node's tenant identity, with `payload` as input. The graph
id must be one this node actually exposes in its runtime catalog (see
[Agent Development](./agent-development.md)).

## `route:` schedules — http-dispatch (pending per-node credentials)

🟡 **Not working yet.** A `route:` schedule has the operator POST to one of your
node's own token-gated routes on each fire. The operator dispatches under a
**per-node credential that is fail-closed**, and that credential is **not yet
provisioned**. Until the per-node-credential (secrets-on-spawn) work lands,
`route:` schedules will **fail closed** rather than dispatch.

Document and stage them now; they go live **once per-node dispatch credentials
are provisioned**.

```yaml
schedules:
  - id: metrics-ingest
    cron: "*/15 * * * *"
    timezone: UTC
    route: /api/internal/ops/metrics-ingest   # node-relative path only
    payload: { window: "15m" }
```

### Idempotency is the node's responsibility (hard contract)

For a `route:` schedule, the operator sends:

```
Idempotency-Key: <nodeId>/<scheduleId>/<scheduledFor>
```

and **retries are disabled** (`maximumAttempts: 1`). Your route **MUST dedup on
that header** — treat a repeat of the same `Idempotency-Key` as a no-op that
returns the already-computed result. The operator will not retry, but at-least-once
delivery semantics mean you must be safe against a duplicate of the same key.

Derive your dedup key from the header, persist a marker keyed by it, and short-circuit
on a hit. Do not key idempotency off wall-clock time or request body.

### `route:` constraints

- **Node-relative only.** `route` must be a path beginning with `/` (e.g.
  `/api/internal/ops/...`). Absolute URLs or foreign hosts are rejected by the
  operator's SSRF guard.
- **Token-gated.** The route must require the node's auth (it is reached over the
  node's own perimeter). See [Add a Node Secret](./add-secret.md) if it needs a
  shared secret to verify the caller.

## What's available, at a glance

| Schedule kind          | Status                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `graph:`               | ✅ Works today — graph execution is proven live end-to-end.            |
| `route:` (http-dispatch) | 🟡 Available once per-node dispatch credentials are provisioned. Fail-closed until then. |

## PR proof

- `.cogni/repo-spec.yaml` declares the `schedules:` entry with **exactly one** of
  `graph` or `route`.
- For a `route:` schedule, the target route dedups on the `Idempotency-Key`
  header and is node-relative.
- The named `graph` id (if used) is exposed by this node's runtime catalog.

## Related

- [Agent Development](./agent-development.md) — adding the graph a `graph:` schedule runs.
- [Add a Node Secret](./add-secret.md) — a shared secret your `route:` can verify against.
- [Temporal Patterns](../spec/temporal-patterns.md) — the operator-side execution model (determinism, overlap/catchup defaults, idempotency) you inherit without writing Temporal code.
</content>
</invoke>
