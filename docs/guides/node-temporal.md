---
id: guide.node-temporal
type: guide
title: Building durable agent workflows in a node
status: draft
trust: draft
summary: "Build a node-owned Temporal Workflow around node-owned LangGraph runs. The operator provisions the shared Temporal service and private Worker runtime; the node owns Workflow code, schedules, release, and health."
read_when: "You are adding scheduled AI, durable orchestration, retries, timers, signals, or human-in-the-loop work to a node."
owner: derekg1729
created: 2026-06-18
verified: 2026-10-09
tags: [temporal, langgraph, node-template, scheduling, guide]
---

# Building durable agent workflows in a node

The default product unit is a **durable agent workflow**:

```text
node-owned Temporal Workflow          durable outer control flow
  → node-owned Activity
      → node app GraphExecutorPort
          → node-owned LangGraph      AI reasoning/dataflow
```

The operator supplies the shared Temporal service, creates the environment-scoped node
namespace, wires the private Worker, and deploys app plus Worker from one source SHA. The node
owns Workflow and Activity code, its LangGraph catalog, schedule declarations, release, and
health. Adding a node Workflow never requires a centralized Worker release.

## Start with the working scaffold

- `packages/workflows` contains replay-safe Temporal Workflows.
- `services/workflow-worker` registers those Workflows and their Activities.
- `packages/agent-workflow-runtime` contains only reusable Worker, schedule, and contract glue.
- `packages/langgraph-graphs` contains node-owned LangGraph graphs.
- `.cogni/repo-spec.yaml` declares the private Worker and recurring Workflow schedules.

Node code imports `@temporalio/*` and `@langchain/langgraph` directly. The Cogni runtime package
is deliberately thin: it supplies integration defaults, not a second orchestration framework.

## Add a recurring Workflow

1. Export a Workflow function from `packages/workflows`. Keep it deterministic: no network,
   filesystem, database, environment, random, or wall-clock access in Workflow code.
2. Put side effects in Activities. A graph Activity calls the app's private graph-run route so
   execution continues through the existing `GraphExecutorPort`, billing, grant, idempotency,
   and telemetry path.
3. Add its stable type to the Worker catalog.
4. Declare the schedule in `.cogni/repo-spec.yaml` with the explicit `workflow` target.
5. Inspect the deployed substrate with `pnpm temporal:health -- --env candidate-a`.

```yaml
schedules:
  - id: nightly-research
    cron: "0 0 * * *"
    timezone: UTC
    workflow: ScheduledGraphWorkflow
    payload:
      graphId: "langgraph:research"
      input:
        messages: [{ role: user, content: "Research today's open question." }]
        modelRef: { providerKey: platform, modelId: gpt-4o-mini }
```

The app reconciles only explicit `workflow` entries into the node namespace and stable
`agent-workflows` Task Queue. Existing `graph` and `route` entries remain on the centralized
compatibility lane until an explicit per-schedule migration; Worker presence never retargets
them implicitly.

## Release handshake

The Worker starts with deployment name `node-<nodeId>-workflows`, exact source SHA as Build ID,
Worker Versioning enabled, and `PINNED` default behavior. Its private `/readyz` reports node ID,
namespace, Task Queue, deployment, Build ID, registered Workflow types, and both poller states.

At startup the app:

1. verifies the private Worker identity and exact Build ID;
2. waits until Temporal sees that Worker Deployment Version;
3. makes and verifies that exact version current;
4. reconciles full schedule action state with overlap `SKIP` and Temporal's minimum positive
   catchup window of `10s`;
5. deletes node-owned schedules removed from repo-spec; and
6. eagerly triggers a newly created schedule once, giving candidate validation immediate proof.

To retire the Worker, first remove its Workflow schedules while leaving the Worker service
declared. Deploy and verify zero orphaned schedules, then remove the Worker in a second release.

Production remains fail-closed until Temporal enforces namespace-scoped authentication. The
private Worker profile is candidate/preview-only during that boundary rollout.

## One-call health

`GET /api/v1/temporal/health` is authenticated and returns non-2xx unless the whole substrate is
healthy. `pnpm temporal:health -- --env <env>` calls it with `COGNI_NODE_API_KEY` and exits
non-zero on unhealthy, timeout, authentication failure, or malformed output.

Healthy means all of the following are true:

- the Workflow and Activity pollers are polling;
- Worker node, namespace, queue, catalog, deployment, and Build ID match the app;
- the exact Worker Deployment Version is current;
- declared schedules exist without action drift or pause, and no orphaned node schedules exist;
  and
- the latest eager/due Workflow completed successfully.

The endpoint emits exactly one `substrate.temporal.health_checked` terminal event and bounded,
low-cardinality metrics. It never returns prompts, tokens, credentials, or raw graph output.

## Rules

- Temporal Schedules, never process cron.
- AI work and external I/O live in Activities/graphs, never Workflow code.
- Every Activity is idempotent under retry; graph calls use a stable idempotency key.
- The app owns schedule reconciliation; the Worker never creates or updates schedules.
- App and Worker ship from the same source SHA.
- CI is qualification only. Completion requires `/validate-candidate`: exact `/version` SHA,
  healthy deployed diagnostic, completed Workflow/graph run, and feature-specific Loki evidence.

## References

- [substrate-temporal.md](../spec/substrate-temporal.md) — ownership and runtime topology.
- [temporal-patterns.md](../spec/temporal-patterns.md) — replay, retries, schedules, versioning.
- [langgraph-patterns.md](../spec/langgraph-patterns.md) — node graph execution boundary.
