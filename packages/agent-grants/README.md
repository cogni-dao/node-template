# @cogni-dao/agent-grants

Runtime tool authority for a Cogni node's agents. A tool runs only when its graph lock, principal lock and subject lock all open.

```ts
import { guardTools, createPostgresAgentGrantsStore } from "@cogni-dao/agent-grants";

const guarded = guardTools(runtimes, requiresById, { principalId, subjectUserId, payer }, {
  withStore: (fn) => sql.begin((tx) => fn(createPostgresAgentGrantsStore(tx))),
  adminCheck: async (subjectUserId) => "allow", // the node's own admin authority
});
```

`subjectUserId` is the authenticated caller (a bearer agent included); it only narrows. An `account` tool is denied.

The node keeps its routes, migration, seeds and declared scopes. This package holds no private `@cogni/*` import and no ExecutionScope.
