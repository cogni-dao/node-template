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
