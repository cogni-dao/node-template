# Build a Cogni node

The canonical full-app template for a community-owned AI service: auth, payments, governance,
deployment, observability, durable knowledge, and agent infrastructure included.

- [Launch your node](https://cognidao.org/nodes)
- [Explore live nodes](https://cognidao.org/explore/nodes)
- [Visit Cogni](https://cognidao.org)

## Develop locally

Use this node's [local environment example](.env.local.example) and the
[local agent development guide](https://cognidao.org/knowledge/local-agent-development).
The current local proof uses an explicitly configured shared local substrate.
This repository does not include a cold-machine infrastructure installer. The guide
is described in that guide; [agent infrastructure](https://cognidao.org/knowledge/agent-infrastructure-expert)
owns the existing execution contract.

```bash
pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile
cp .env.local.example .env.local   # then fill local secrets + create this node's databases
pnpm dev:preflight                 # validate env fail-closed (starts nothing)
pnpm dev:stack                     # build packages, migrate, run app + LangGraph dev (stays running)

# In a second terminal: mint a local identity, then verify the whole stack.
mkdir -p .context
curl -sX POST http://localhost:3200/api/v1/agent/register \
  -H 'content-type: application/json' -d '{"name":"local"}' > .context/local-dev-identity.json
pnpm dev:verify --identity .context/local-dev-identity.json   # → { "ok": true }
```

`dev:stack` builds this repo's workspace packages first (so dist-importing steps resolve),
applies this node's existing migrations, then runs this checkout's app and LangGraph dev
together until Ctrl-C. It does not seed knowledge, and refuses remote storage or occupied
ports. `pnpm langgraph:dev` starts only the graph server. `dev:verify`'s authenticated
checks need the minted identity above; its knowledge/work-item body reads are skipped on a
fresh empty node, while deep readiness and authenticated graph discovery still prove the
stack. A green readiness check or Studio graph listing alone does not prove a working run.

To recover an existing node's local knowledge and goals, download its authenticated
knowledge, cognition and graph snapshots as described in the guide, then run
`pnpm hub:restore:local --knowledge <knowledge.json> --cognition <cognition.json> --graph <graph.json>`.
The command checks node identity and a loopback database, creates a backup branch,
restores the snapshot rows and citation edges, and preserves other local rows.
It never copies work items or pushes a remote. A public DoltHub mirror can be stale;
verify its contents before using it as recovery data.

The standalone launcher uses the billed in-process graph runtime for real node tools;
Studio runs separately for isolated graph experiments. Rebuild packages after changing
graph source used by the app. Browser UI compilation is included in `dev:verify`;
verify wallet sign-in and an actual chat separately before calling development complete.

## Continue with your AI agent

Open your generated repository in Claude Code, Codex, or OpenCode and paste:

> Follow the repository instructions already loaded for this session. Discover this node's live
> contributor contract and an unclaimed work item, then propose one measurable Goal and Done when.
> After I approve them, own the work through CI, candidate validation, operator merge, and proof.

Every supported harness receives the node's cognition automatically; contributors do not install or
copy per-node prompt configuration.

[PolyForm Shield license](LICENSE.md)
