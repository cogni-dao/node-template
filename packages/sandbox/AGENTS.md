# sandbox

Published `@cogni-dao/sandbox` owns the node sandbox mechanism: the OpenSandbox execd client, the sandbox host derivation, the fixed call wrapper (the model's text only in `envs`), merged output with head and tail, `timeout` classification, the per-run in-process queue and the cleanup tick. `createSandboxShellCapability({ baseUrl, accessToken, runId, onTick, callEnv? })` returns the capability `core__sandbox_shell` (in `@cogni-dao/ai-tools`) calls.

Leaf package: no app, container, env or logger imports. The node reads `SANDBOX_EXECD_TOKEN` and `SANDBOX_BASE_URL`, supplies `runId` from its execution scope and writes the `adapter.sandbox.tick` event from `onTick`, and may pass `callEnv`, which runs when each call starts and adds env such as a 1-hour `GH_TOKEN` (never overriding `SB_*`). The image source is `services/sandbox/` in the node repo.

Design and operation: hub atoms `node-sandbox-design`, `node-sandbox-lifecycle`, `node-sandbox-keys`, `node-sandbox-adopt`.

```bash
pnpm --filter @cogni-dao/sandbox test
```
