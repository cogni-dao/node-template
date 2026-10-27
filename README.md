# Build a Cogni node

The canonical full-app template for a community-owned AI service: auth, payments, governance,
deployment, observability, durable knowledge, and agent infrastructure included.

- [Launch your node](https://cognidao.org/nodes)
- [Explore live nodes](https://cognidao.org/explore/nodes)
- [Visit Cogni](https://cognidao.org)

## Develop locally

Use this node's [local environment example](.env.local.example) and the
[local agent development guide draft](https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-469da024).
The current local proof uses an explicitly configured shared local substrate.
This repository does not include a cold-machine infrastructure installer. The guide
is awaiting review; [agent infrastructure](https://cognidao.org/knowledge/agent-infrastructure-expert)
owns the existing execution contract.

```bash
pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile
# Configure .env.local and provision this node's local databases first.
pnpm dev:preflight
pnpm dev:stack
pnpm dev:verify   # confirm the whole stack: { "ok": true }
```

`dev:stack` builds this repo's workspace packages, applies this node's existing
migrations, then starts this checkout's app and LangGraph dev together. The package
build removes the stale-`dist` resolution footgun, so the app and its tools load
cleanly. It does not seed knowledge. It refuses remote storage and occupied ports.
Ctrl-C stops both processes. `pnpm langgraph:dev` starts only the graph server.
Validate through the node's authenticated API with `pnpm dev:verify`; a green
readiness check or a Studio graph listing alone does not prove a working agent run.

## Continue with your AI agent

Open your generated repository in Claude Code, Codex, or OpenCode and paste:

> Follow the repository instructions already loaded for this session. Discover this node's live
> contributor contract and an unclaimed work item, then propose one measurable Goal and Done when.
> After I approve them, own the work through CI, candidate validation, operator merge, and proof.

Every supported harness receives the node's cognition automatically; contributors do not install or
copy per-node prompt configuration.

[PolyForm Shield license](LICENSE.md)
