# agent authority SQL tails

**The factory writes the tables; these files hold only the SQL that Drizzle cannot emit** (FORCE row-level security, functions, triggers, the seed, grants). We chose tails over idempotent full templates because the node never edits the package's tables: `defineAgentAuthoritySchema` (`@cogni-dao/agent-grants/schema`) already emits the final shape, including the account columns, the org columns, the widened kind CHECK and both select policies. A second copy of that DDL in a template could only drift or fail on a fresh database.

A fresh node:

1. Call `defineAgentAuthoritySchema({ users, billingAccounts })` in the node's own schema package, re-export the result, and run the node's `db:generate`. drizzle-kit writes every table, index, CHECK and policy, and the snapshot, against the node's own prior snapshot. Never copy a snapshot.
2. Append these tails, in this order, to that generated migration (or to the next one): `agent_authority.sql` (FORCE RLS and the seed of `node-ai` and `prioritizer`), `agent_account_grants.sql` (the table privilege and `agent_has_scope()`), `agent_credentials.sql` (FORCE RLS, `agent_credential_state()` and the external-principal trigger). Each file says what it needs first.
3. Add one delegated select policy per node table that holds an account's data (the comment at the end of `agent_account_grants.sql` shows two).
4. Write the AGENT_WALLET_IS_NOT_A_PAYEE trigger (node-template 0043) and the principal backfill (0044) yourself: they change tables the node owns (`user_bindings`, the payout leaf tables). `runAgentWalletGuardConformance` fails the node's real-SQL run when the trigger is missing from a leaf table.
5. Run `db:check`. The journal `when` must be greater than every earlier entry. Run the conformance suites over the node's real SQL store as the app role.

`agent_roles` and `agent_principals` carry the org columns on every node; they stay null until a node adopts orgs. The tests `app/tests/component/db/agent-authority-tails.int.test.ts` (node-template) generate the migration from the factory on an empty database, append these tails and assert the guard objects, so the factory and the tails cannot drift apart unseen.

# payer_bindings migration template

`payer_bindings.sql` is the shape a node applies for payer bindings (`@cogni-dao/agent-grants`, story.0038 phase 2, `createPostgresPayerBindingStore`). node-template keeps it as `0046_payer_bindings.sql`. Do not copy it blind into a fork:

1. Add the `payerBindings` table (the columns, the unique partial index `payer_bindings_open_per_subject` on `subject_user_id WHERE revoked_at IS NULL`, the account index and the two CHECKs) to the node's own schema package, then run the node's `db:generate`. drizzle-kit writes the DDL and the snapshot against the node's own prior snapshot. Never copy a snapshot.
2. Append the hand-written part (everything after the line `Hand-written below`): `FORCE ROW LEVEL SECURITY`. The table has no policy, so the app role sees nothing.
3. The store needs a BYPASSRLS (service role) connection, like `agent_roles`.
4. Run `db:check`. The journal `when` must be greater than every earlier entry.

# Adopting org accounts: three releases, three deploys (task.0181)

The grants index and the org feature reach a node in this order. Each step is its own release of `@cogni-dao/agent-grants` and its own deploy of the node; never fold two steps into one deploy.

1. **0.11.0, release A.** Adopt it, run the node's `db:generate`, deploy. It adds `agent_roles_live_account_unique` (principal, scope, `coalesce(account_id, '')`) beside the old `agent_roles_live_unique` and moves every writer to a bare `ON CONFLICT DO NOTHING`. Pods of the previous release keep working against the old index.
2. **0.12.0, release B.** Adopt it only after A is deployed and no pod of the previous release runs. Run `db:generate` (it emits the `DROP INDEX`), deploy. One principal may now hold a scope on several accounts.
3. **0.13.0, the org feature.** Adopt it only after B is deployed. Run `db:generate`, append `org_accounts.sql` after the generated SQL, deploy. The feature's migration assumes the old index is gone.

Skipping a step, or deploying two together, leaves pods of one release running against a schema the next one changed.
