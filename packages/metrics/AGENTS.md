# metrics

Published @cogni-dao/metrics owns contracts, calculator registry, bounded computation, evidence selection and injected observation adapters.

No app, knowledge-store, Temporal, environment, migration or pool lifecycle imports. `./schema` exports table definitions only (optional `drizzle-orm` peer) plus `METRIC_FORCE_RLS_SQL`; each node re-exports it from its db-schema and generates its own migrations. Nodes own sources, authorization, clocks, migrations, routes, UI and composition. Root and adapter share typed errors. Preserve units, immutable completed observations, request snapshots, fencing, source coverage, and unknown results. Prove packed JavaScript and declarations in a clean consumer.
