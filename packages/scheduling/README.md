# @cogni-dao/scheduling

Owned schedule contracts and run-history readback, with optional PostgreSQL and pure presentation entrypoints.

```text
Temporal → node GraphExecutor → graph_runs + stateKey
                                      ↓
                            scheduling readback
                                      ↓
                         node history → existing chat
```

The node retains its executor wiring, authenticated routes, app-role database pool and conversation authorization. This package reads existing execution metadata; it does not start work or render transcripts.

```ts
import { createScheduleHistoryService } from "@cogni-dao/scheduling";
import { PostgresScheduleRunReader } from "@cogni-dao/scheduling/adapters/postgres";
import { presentScheduleRun } from "@cogni-dao/scheduling/presentation";

const history = createScheduleHistoryService({
  getSchedule: (caller, id) => nodeOwnedScheduleLookup(caller, id),
  reader: new PostgresScheduleRunReader(existingAppRoleSql),
});
```

The PostgreSQL entrypoint requires the consumer's `postgres` peer. It uses the existing `schedules` and `graph_runs` schema, RLS and a parameterized transaction-local caller context. Inject the app-role pool; never a service-role pool. Root and presentation have no framework or driver runtime dependency.

Nodes pin the immutable GitHub Release tarball and keep their local import alias. [Distribution contract](https://cognidao.org/knowledge/publish-shared-runtime-core) · [design](https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-ee9eb314).

### Governance routing (server only)

`@cogni-dao/scheduling/routing` exports `syncGovernanceSchedules`, structural
control/config/result types and `governanceGraphMessage`. Bind `scheduleIdFor`
and `ownsScheduleId` to the same node prefix and explicit legacy exceptions;
provide own system-row prune candidates, existing error predicates, grant/upsert
ports and a node-local `resolveLedgerIngestExecution` callback. The callback
receives the single governance grant and may return null for ordinary routing.
The package does not select a node's mission graph/model or own ledger policy.
Graph actions are fully reapplied before resume; prune pauses and owner-disables.
Flat legacy identities retain their inherited custody limits, not a global
ownership guarantee. Root/presentation imports do not load this server entry.
