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

# service_assertion_jtis migration template

`service_assertion_jtis.sql` is the shape a node applies for the durable replay store (`@cogni-dao/agent-grants/service-auth` `createPostgresReplayStore`, 0.10.0). node-template keeps it as `0049_service_assertion_jtis.sql`. Do not copy it blind into a fork:

1. Add the `serviceAssertionJtis` table (`jti` primary key, `expires_at`, the expiry index) to the node's own schema package, then run the node's `db:generate`. drizzle-kit writes the DDL and the snapshot against the node's own prior snapshot. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`): `FORCE ROW LEVEL SECURITY`. The table has no policy, so the app role sees nothing; the store needs a BYPASSRLS (service role) connection.
3. Run `db:check`. The journal `when` must be greater than every earlier entry.

# org_accounts migration template

`org_accounts.sql` is the shape a node applies for org accounts (`@cogni-dao/agent-grants` 0.10.0, `./org-accounts`, `./org-links`). node-template keeps it as `0050_org_accounts.sql`; the file is that migration byte for byte under a two-line header. Do not copy it blind into a fork:

1. In the node's own schema package add: the tables `orgInvites`, `orgLinkCodes` and `orgLinks` (their CHECKs and the unique partial indexes `org_invites_open_per_wallet` and `org_links_open_per_issuer`); `suspended_at` on `agentPrincipals`; `link_id` (a foreign key to `org_links`) on `payerBindings`; and the account-aware live-row index `agent_roles_live_account_unique` on `agentRoles` as `(principal_user_id, scope, coalesce(account_id, ''))` where `revoked_at IS NULL`. KEEP the old `agent_roles_live_unique` (principal_user_id, scope) index. Then run the node's `db:generate`. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`): `FORCE ROW LEVEL SECURITY` on the three new tables. They have no policy.
3. The change is additive (release 1 of two): the previous release's `ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL` keeps working, and so does a rollback. The old index is dropped in release 2 (task.0175), after every node runs release 1; a person then holds a role in up to five orgs.
4. Run `db:check`. The journal `when` must be greater than every earlier entry. Run `runGrantConformance` over the node's real SQL store (it now expects `authorizeAccount` to honour a live grant for a session caller).

# org_roles_forward migration template

`org_roles_forward.sql` is the forward migration a node applies after `org_accounts.sql`: the actor columns and the index repair. node-template keeps it as `0051_org_roles_forward.sql`; the file is that migration byte for byte under a header. Do not copy it blind into a fork:

1. Add `revoked_by` (a foreign key to `users`) to `agentRoles`, `suspended_by` and `created_by` to `agentPrincipals`, and `created_by` to `orgLinks`, then run the node's `db:generate`. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`). It is safe to run again. It ends every live row but the OLDEST per (principal, scope) with `revoked_by` NULL (the migration, not a person, ended them; the UPDATE runs between `NO FORCE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, because the migrator is the table's owner without BYPASSRLS and under FORCE its UPDATE would match no row, while the index build below still sees them all), drops an account-aware index that took the old index's name, and creates `agent_roles_live_unique` (the old two-column index) and `agent_roles_live_account_unique` if either is missing. On a database that never ran the rejected first `0050` it changes nothing.
3. Run `db:check`. The journal `when` must be greater than every earlier entry.
