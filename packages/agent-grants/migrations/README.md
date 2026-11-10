# agent_credentials migration template

`agent_credentials.sql` is the FINAL shape a node applies for the `@cogni-dao/agent-grants/credentials` store: node-template's `0039_agent_credentials.sql`
plus `0040_agent_credentials_key_upgrade.sql` folded into one (node-template applied 0039 first, and applied migrations are immutable, so it
carries a second migration; a fresh fork needs only this file). Do not copy it blind into a fork:

1. Add the `agentCredentials` table to the node's own schema package, then run the node's `db:generate`. drizzle-kit writes the table DDL and
   the snapshot against the node's own prior snapshot. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`): FORCE RLS, `agent_credential_state()` and the
   external-principal trigger. Drizzle cannot emit them.
3. The node needs `agent_principals` (migration 0036 shape) first. The trigger reads it.
4. Run `db:check`. The journal `when` must be greater than every earlier entry.

The store needs a BYPASSRLS (service role) connection: the table has no policy, so the app role sees nothing.
