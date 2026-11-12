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

The corrected enrollment provider also needs `agent_service_enrollment_maintenance.sql` after the enrollment table exists. These active-set,
latest-role and child-working-set indexes support bounded maintenance and the existing admin Off/On control. Add the indexes to the adopter's
own schema and auto-generate its migration; do not edit any exercised enrollment migration or copy a snapshot. Node-template owns this as
additive migration `0042_service_enrollment_maintenance`. Apply before the corrected provider serves traffic; publishing/adoption stays gated
on independent review and real-Postgres conformance. Role writers need a begin-capable client or an existing postgres transaction-bound tag.
