# sandbox-workspace · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Server-only client and shell for this node's **remote** code-execution workspace: the `sandbox` service in
`.cogni/repo-spec.yaml` (OpenSandbox execd behind Caddy, built from `services/sandbox/`), deployed by the
operator as its own isolated lease. Distinct from `../sandbox/`, which runs ephemeral local Docker containers.
Design: [node-sandbox-design](https://node-template.cognidao.org/knowledge/node-sandbox-design).

## Pointers

- [Sandbox image](../../../../../services/sandbox/)
- [execd API](https://github.com/opensandbox-group/OpenSandbox/blob/main/specs/execd-api.yaml)
- [Factory](../../../bootstrap/capabilities/sandbox-workspace.ts)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["ports", "shared", "types"],
  "must_not_import": ["app", "features", "core", "contracts"]
}
```

## Public Surface

- **Exports:** `ExecdSandboxClient`, `SandboxShell`, `SandboxRequestError`, `deriveIsolatedServiceOrigin`, `SANDBOX_SERVICE_NAME`, `EXECD_ACCESS_TOKEN_HEADER`
- **Env/Config keys:** none read here; the factory resolves `SANDBOX_EXECD_TOKEN`, `SANDBOX_BASE_URL`, `APP_BASE_URL`
- **Files considered API:** index.ts

## Responsibilities

- This directory **does**: derive `<slug>-sandbox[-<env>]` from the app's own origin; run one command via `POST /command` with the `X-EXECD-ACCESS-TOKEN` header; merge stdout and stderr and keep head and tail of long output; run each call in `/workspace/<runId>` through a fixed wrapper (user text only in `envs`); order one run's calls in process; send the cleanup tick at most every 5 minutes while the tool is used.
- This directory **does not**: expose a model-facing tool, cap commands in flight, manage execd sessions/files/PTY, or log command text or output.

## Notes

- No app-to-sandbox repo-spec binding exists: cross-lease bindings are refused, so the host is derived.
- The sandbox refuses to start without a ≥32-char token; the client refuses to construct without one.
- The per-run queue is in process: one app instance per node and lane is the whole picture in v0.
