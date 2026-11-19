# agent_credentials migration template

`agent_credentials.sql` is the FINAL shape a node applies for the `@cogni-dao/agent-grants/credentials` store: node-template's `0039_agent_credentials.sql`
plus `0040_agent_credentials_key_upgrade.sql` folded into one (node-template keeps them as two migrations; a fresh fork needs only this
file, and it must not copy node-template's `DROP TABLE IF EXISTS ... CASCADE`, which only cleans a table leaked onto node-template's shared candidate database). Do not copy it blind into a fork:

1. Add the `agentCredentials` table to the node's own schema package, then run the node's `db:generate`. drizzle-kit writes the table DDL and
   the snapshot against the node's own prior snapshot. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`): FORCE RLS, `agent_credential_state()` and the
   external-principal trigger. Drizzle cannot emit them.
3. The node needs `agent_principals` (migration 0036 shape) first. The trigger reads it.
4. Run `db:check`. The journal `when` must be greater than every earlier entry.

The store needs a BYPASSRLS (service role) connection: the table has no policy, so the app role sees nothing.

# agent_account_grants migration template

`agent_account_grants.sql` is the FINAL shape a node applies for account-resource grants on `agent_roles` (`@cogni-dao/agent-grants` 0.6.0). node-template keeps it as `0041_agent_account_grants.sql`. Do not copy it blind into a fork:

1. Add the new columns, the five CHECKs, the unique `link_hash` index and the one select policy (`agent_roles_account_self_read`) to the node's own `agentRoles` schema, then run the node's `db:generate`. drizzle-kit writes that part and the snapshot against the node's own prior snapshot. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`): the table privilege, `agent_has_scope()` (SECURITY INVOKER, no PUBLIC execute) and one delegated select policy per table that holds an account's data. Drizzle cannot emit them.
3. Keep `agent_roles_live_unique` and the old `ON CONFLICT` targets (EXPAND-ONLY). The contract migration (task.5484) replaces them.
4. Run `db:check`. The journal `when` must be greater than every earlier entry. Run `runGrantConformance` over the node's real SQL store, and check row-level security as the real app role (owner, live grant, foreign, expired, revoked: 0 rows).

# agent_principals_orgs migration template

`agent_principals_orgs.sql` is the shape a node applies for orgs (`@cogni-dao/agent-grants` 0.8.0, `./orgs`). node-template keeps it as `0045_agent_principals_orgs.sql`. It is plain SQL that drizzle-kit emits, so a node can mirror it exactly:

1. Add the two nullable columns `owner_source_kind` and `owner_source_ref`, the CHECK `agent_principals_org_has_owner_source`, the widened kind CHECK `('internal','external','org')` and the unique partial index `agent_principals_org_source_unique` (one org per owner source, `WHERE kind = 'org'`) to the node's own `agentPrincipals` schema, then run the node's `db:generate`. Never copy a snapshot.
2. Existing rows are untouched (both columns are null; only an `org` row must carry them).
3. Run `db:check`. The journal `when` must be greater than every earlier entry.

# payer_bindings migration template

`payer_bindings.sql` is the shape a node applies for payer bindings (`@cogni-dao/agent-grants`, story.0038 phase 2, `createPostgresPayerBindingStore`). node-template keeps it as `0046_payer_bindings.sql`. Do not copy it blind into a fork:

1. Add the `payerBindings` table (the columns, the unique partial index `payer_bindings_open_per_subject` on `subject_user_id WHERE revoked_at IS NULL`, the account index and the two CHECKs) to the node's own schema package, then run the node's `db:generate`. drizzle-kit writes the DDL and the snapshot against the node's own prior snapshot. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`): `FORCE ROW LEVEL SECURITY`. The table has no policy, so the app role sees nothing.
3. The store needs a BYPASSRLS (service role) connection, like `agent_roles`.
4. Run `db:check`. The journal `when` must be greater than every earlier entry.

# org_connections migration template

`org_connections.sql` is the shape a node applies for connect from home (`@cogni-dao/agent-grants` 0.9.0, `./connections`, `createPostgresReplayStore`). node-template keeps it as `0048_org_connections.sql`. It is ADDITIVE and standalone: it creates two new tables and touches nothing 0.8.0 shipped, so a node that mirrored `agent_principals_orgs.sql` and `payer_bindings.sql` exactly does not edit them. Mirror it exactly:

1. Add the `orgConnections` table (the columns, the unique indexes `org_connections_issuer_unique` and `org_connections_billing_account_unique`, the three CHECKs, the two foreign keys) and the `serviceAssertionJtis` table (`jti` primary key, `expires_at`, the expiry index) to the node's own schema package, then run the node's `db:generate`. drizzle-kit writes the DDL and the snapshot against the node's own prior snapshot. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`): `FORCE ROW LEVEL SECURITY` on both tables. Neither has a policy, so the app role sees nothing; the store needs a BYPASSRLS (service role) connection.
3. The `issuer` org source kind needs NO schema change: `agent_principals.owner_source_kind` is plain text and the 0.8.0 CHECK only requires both source columns on an `org` row. The new rows are `org` principals of kind `issuer`, written by `ensureOrg`.
4. `payer_bindings` is unchanged: `connect` writes ordinary live rows into it (one per service principal of the issuer), approved by the record's own org user. The record's state (status, suspended, cap, seq) lives in `org_connections`, one row per customer, because a payer row is one per subject.
5. Run `db:check`. The journal `when` must be greater than every earlier entry.

# outbound_connections migration template

`outbound_connections.sql` is the shape a node applies for the CUSTOMER side of connect from home (`@cogni-dao/agent-grants` 0.9.0, `createConnectSender`, `createPostgresOutboundConnectionStore`): one row per provider origin holding what this node last told it (`status`, `cap`) and the last `seq` it signed, so the seq rises across restarts. node-template keeps it inside `0049_outbound_connections.sql`, which also carries one node-local statement (a partial unique index on `credit_ledger` for allowance references) that is NOT part of this template. Mirror the table, the two CHECKs and the FORCE RLS exactly: add `outboundConnections` to the node's schema package, run `db:generate`, append the hand-written `FORCE ROW LEVEL SECURITY` (no policy: service role only), run `db:check`. A node that only acts as a provider needs no outbound table.

# charge_receipts_account_charged_idx migration template

`charge_receipts_account_charged_idx.sql` is one index, `("billing_account_id", "charged_credits")` on `charge_receipts` (node-template `0050_charge_receipts_account_charged_idx.sql`). The run gate sums an account's charged credits on every run billed to a connected org (`createPostgresConnectionStore().standingOf`); with this index the sum is an index-only scan of that account's receipts and needs no per-run table read. A provider node mirrors it before adopting the gate (add the index to the node's own `chargeReceipts` schema and run `db:generate`).

