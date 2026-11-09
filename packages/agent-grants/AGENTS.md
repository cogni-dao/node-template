# agent-grants

Published `@cogni-dao/agent-grants` owns runtime tool authority: `authorize()`, role-row reads and writes, and `guardTools()` that wraps every tool runtime's `exec`.

- A tool runs only when its graph lock, principal lock and subject lock open. Read-only tools need only the graph lock. Design: https://cognidao.org/knowledge/node-capability-grants-standard (section "Runtime identity does not depend on hosting").
- No private `@cogni/*` import, no app ExecutionScope, no ai-core import. Runtimes are structural (`id`, `effect`, `exec`). The node passes `withStore`, `adminCheck`, `onDecision` and `runAs`.
- `/postgres` adapter (exported from the root) takes an injected tagged-template function. It never creates a client or switches a role. `agent_roles` has FORCE RLS and no policy, so only a service-role connection reads or writes it. `agent_principals` has a read-only select policy for every role (the wallet-binding trigger needs it); only a service-role connection writes it.
- A denial throws `ToolAuthorityError` with `receipt {code, retryable:false, lookup}`. The message is fixed and never names a role or scope.
- Every authenticated caller is the run subject, bearer agents included. A subject only narrows: `admin` means a principal the DAO approved; no AI identity is approved yet (item I2), so an agent fails `admin` tools, passes `member` tools, and `own` tools run on its own rows. Account scopes are out of scope: an `account` tool is denied with `policy_denied`.
- `node-ai.ts` holds the admin table copy: `NODE_AI_COPY` (default AI names a node may override) and `buildNodeAiView()` (one row per AI and permission; permissions come from `requires.label`; a scope with no label is skipped, a slug is never shown as a name). The store port also lists live roles (`listLiveRoles`) for that view.
- `same-door.ts` is SAME_DOOR: `SAME_DOOR_ROUTES` maps each write tool to the route ids that twin it, `ROUTE_ONLY_CAPABILITIES` declares routes no tool twins (`knowledge.contribute`), `NO_ROUTE_TWIN` allowlists tools with no node route, and `authorizeCaller()` is the route door (a bearer is its own principal and needs a live role row; a human session passes the subject rules). A parity test in `@cogni-dao/langgraph-graphs` fails on any unmapped write tool.
- DENIAL_IS_TERMINAL: `offeredToolIds()` drops tools whose principal lock already fails, and `guardTools` calls `onTerminalDenial` once per exec-time denial so the node ends the run cleanly.
- Roles are never cached. A revoked role denies the next call.
- Declared scopes live in the node, derived from the `requires` on its tool contracts. `grantRole` rejects an undeclared scope.
- Build declarations only with tsc; tsup owns JavaScript.
