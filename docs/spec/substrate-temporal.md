---
id: spec.substrate-temporal
type: spec
title: Temporal Substrate
status: draft
trust: draft
summary: "Temporal is shared infrastructure with node-sovereign execution: each node owns its durable agent Workflows and private Worker while the operator provisions namespaces, identity, deployment wiring, and visibility."
read_when: "Designing, shipping, or debugging scheduled AI, durable orchestration, Worker deployment, schedule reconciliation, or Temporal health on a node."
owner: derekg1729
created: 2026-06-18
verified: 2026-10-09
tags: [temporal, node-template, substrate, scheduling, langgraph]
---

# Temporal Substrate

## Decision

Cogni uses a **node-sovereign architecture for durable agent workflows**. Temporal is the
durable outer runtime and LangGraph is the AI reasoning/dataflow runtime inside it.

The operator owns shared infrastructure:

- the Temporal service and environment lifecycle;
- one namespace and runtime identity per `(node, environment)`;
- secret materialization, deployment wiring, visibility, and decommissioning; and
- admission policy that prevents an unsafe Worker topology from reaching a workload.

Each node owns product execution:

- Workflow and Activity code;
- LangGraph graphs;
- one private Worker and stable `agent-workflows` Task Queue;
- schedule declaration/reconciliation; and
- its app+Worker release and health proof.

A centralized Worker remains only as an explicit compatibility lane for existing generic
`graph` and `route` schedules and for operator-owned governance work. It is not the target for
new node product Workflows.

## Why

Node workflow code must evolve with the node's product, graph catalog, and release. Putting that
code in a fleet-wide Worker makes every node release depend on operator deployment, couples
unrelated products, and hides failures behind a shared poller. Shipping a private Worker in the
same source-SHA artifact bundle as the app restores release ownership while retaining one
operator-managed Temporal service.

The infrastructure boundary stays thin: nodes use the official `@temporalio/*` and
`@langchain/langgraph` packages directly. `@cogni-dao/agent-workflow-runtime` carries only
shared contracts and safe defaults for Worker startup, schedules, and health.

## Declare → provision → create → execute

### 1. Declare

The node's repo-spec declares one public app, at most one private
`cogni-workflow-worker-v1` service, and recurring entries with an explicit `workflow` target.
The worker may be environment-gated. A Workflow schedule is invalid without the Worker profile.

### 2. Provision

The operator creates namespace `cogni-<env>-<nodeId>` and deploys app plus Worker from the same
exact source SHA. The runtime profile injects the node ID, namespace, `agent-workflows` queue,
Worker Deployment name, Build ID, private app URL, and private health URL. Nodes declare only
non-standard bindings and secrets.

The profile is pre-production-only until the Temporal server enforces namespace-scoped auth.
Production admission fails closed; sharing an unauthenticated frontend and relying on a
namespace string is not tenant isolation.

### 3. Create

The node app owns the node-scoped Temporal client and schedule reconciliation. It reconciles
only repo-spec entries whose target is explicitly `workflow`. The action comparison covers
Workflow type, input, Task Queue, cron/calendar, timezone, and policies. Pause state is
never silently overwritten, but a paused declared schedule is unhealthy. Reconciliation also
deletes node-prefixed schedules absent from repo-spec, so removing desired state cannot leave a
billable orphan. Platform invariants are overlap `SKIP` and Temporal's minimum positive
catchup window of `10s`; zero is forbidden because the server interprets it as its large default.

The app verifies the exact Worker before creating work:

1. private `/readyz` identity and both local pollers match;
2. Temporal sees deployment version `node-<nodeId>-workflows.<sourceSha>`;
3. the app makes that version current and verifies propagation; then
4. schedules reconcile and a newly created schedule is eagerly triggered once.

Worker decommission is two-phase: first remove the Workflow schedules while retaining the
private Worker profile, then confirm reconciliation deleted every orphan before removing the
Worker service. This keeps destructive lifecycle changes observable and reproducible.

Existing `graph` and `route` schedule targets remain on the compatibility lane. Merely adding a
Worker never duplicates or retargets a billable schedule.

### 4. Execute

The node Worker registers node-owned Workflow definitions and Activities. Workflow code stays
replay-safe. A graph Activity calls the app's private graph-run endpoint with a stable
idempotency key, so execution continues through `GraphExecutorPort`, execution grants, billing,
deduplication, persistence, and telemetry. Direct graph-host execution in the Worker is rejected
until that complete contract is process-portable.

```text
repo-spec workflow schedule
  → node app reconcile → node namespace / agent-workflows
      → node private Worker (exact source SHA, PINNED)
          → ScheduledGraphWorkflow
              → runGraph Activity
                  → app private graph route
                      → GraphExecutorPort → node LangGraph
```

## Versioning and upgrades

Worker Deployment Versioning is mandatory. The deployment name is
`node-<nodeId>-workflows`; Build ID is the exact source SHA; default behavior is `PINNED`.
Startup never promotes itself. The app activates only a Worker it has independently observed at
the expected identity and SHA. Long-lived Workflows cross incompatible releases through an
explicit Continue-as-New or migration boundary. Old versions remain available while pinned
executions require them.

## Health and observability

Every node exposes authenticated `GET /api/v1/temporal/health` and
`pnpm temporal:health -- --env <env>`. A healthy response proves:

- Temporal and the node namespace are reachable;
- Workflow and Activity pollers are active;
- private Worker identity, registered types, deployment, and Build ID match the app;
- the exact Worker Deployment Version is current;
- declared schedule drift and orphaned node schedule count are zero; and
- the latest due/eager run completed.

The command exits non-zero for every other condition. The health check emits one terminal
`substrate.temporal.health_checked` event with a stable reason code and duration. Metrics expose
last-success time, poller presence by bounded task type, drift count, and check result/duration.
No schedule IDs, Workflow IDs, run IDs, or Build IDs become metric labels; no credentials,
prompts, or raw Workflow inputs/results are logged.

Worker logs are independently queryable by service name, including crash loops. Process uptime,
an open frontend connection, a green build, or a deployed SHA alone is never substrate proof.

## Invariants

| Invariant | Rule |
| --- | --- |
| NODE_OWNS_WORKFLOW | Product Workflow and Activity code ships from the node repo. |
| OPERATOR_OWNS_SUBSTRATE | Temporal service, namespace/identity, runtime wiring, and lifecycle are operator responsibilities. |
| NAMESPACE_PER_NODE_ENV | Namespace derives from the catalog-pinned node ID and environment. |
| APP_WORKER_SAME_SHA | App and private Worker come from one exact-set artifact bundle revision. |
| WORKER_VERSION_GATED | Exact Worker identity/version becomes current before schedule reconciliation. |
| EXPLICIT_CUTOVER | Only explicit `workflow` schedules use the sovereign lane in P0. |
| GRAPH_PATH_SINGLE | Graph Activities reuse the app's billed/idempotent `GraphExecutorPort` path. |
| PRODUCTION_AUTH_REQUIRED | Production rejects the Worker profile until namespace auth is enforced. |
| OBSERVABLE_OR_UNHEALTHY | Missing wiring, pollers, version, schedule, or completed run is a named unhealthy state. |

## References

- [temporal-patterns.md](./temporal-patterns.md) — deterministic implementation rules.
- [langgraph-patterns.md](./langgraph-patterns.md) — graph execution boundary.
- [node-temporal.md](../guides/node-temporal.md) — node-author workflow.
