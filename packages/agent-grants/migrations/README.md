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

# agent_proofs migration template (0.4.0)

`agent_proofs.sql` is node-template's `0041_agent_proof_challenges.sql`: the tables for binding a GitHub account, recovering a key and stopping an agent.

- `agent_proof_challenges`: one proof challenge (`purpose` `bind` or `recover`). Only sha256 of the nonce and of the requester's secret is stored.
- `agent_stops`: one admin stop of one agent. `lifted_at IS NULL` means stopped. A row, lifted or not, also kills the user's signed keys for good.

Same steps as above: add both tables to the node's schema package, run the node's `db:generate`, append the hand-written part (the two `FORCE ROW LEVEL SECURITY`
lines at the end), run `db:check`, and keep the journal `when` above every earlier entry. The tables must exist BEFORE the code serves traffic: the signed-key gate
(`everConfirmed`) reads `agent_stops`. The node needs `user_bindings` and `identity_events` (the bind writes both, in one transaction) and `agent_principals`.
Both tables need a BYPASSRLS (service role) connection.
