# agent_authority migration template

`agent_authority.sql` is the FINAL base shape of `agent_principals` and `agent_roles` and the seed of the two internal principals (`node-ai`, `prioritizer`); node-template keeps it as `0036_agent_authority.sql`, `0037_seed_agent_principals.sql` and `0038_agent_access_requests.sql`. Do not copy it blind into a fork:

1. Call `defineAgentAuthoritySchema` from `@cogni-dao/agent-grants/schema` in the node's own schema package with its `users` and `billingAccounts` tables, then run the node's `db:generate`. drizzle-kit writes the table DDL and the snapshot against the node's own prior snapshot. Never copy a snapshot. The table part of the file shows the shape to expect for the base columns.
2. Append the hand-written part (everything after the line `Hand-written below`): FORCE RLS and the seed. The seed ids and slugs are `INTERNAL_AGENT_PRINCIPALS` in `@cogni-dao/agent-grants`.
3. Add the other templates in this folder in the order of the node-template journal: `agent_account_grants.sql`, `agent_principals_orgs.sql` (only when the node adopts orgs), `agent_credentials.sql`.
4. The AGENT_WALLET_IS_NOT_A_PAYEE trigger (node-template 0043) and the principal backfill (0044) change tables the node owns (`user_bindings`, the payout leaf tables). Each node writes and reviews them itself. `runAgentWalletGuardConformance` fails the node's real-SQL run when the trigger is missing from a leaf table.
5. Run `db:check`. The journal `when` must be greater than every earlier entry. Run the conformance suites over the node's real SQL store as the app role.

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
