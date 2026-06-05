# node-template

Node-at-root template for a **Cogni full-app submodule node** — the canonical single node, minted via GitHub generate-from-template and added as a git submodule at `nodes/<slug>/` in the operator monorepo (`Cogni-DAO/cogni`).

Seeded from `Cogni-DAO/cogni:nodes/node-template/` and projected to a
node-at-repo-root build surface.

- **Node-at-root** layout (`app/`, `graphs/`, `packages/`, `.cogni/`) so it mounts cleanly at `nodes/<slug>/` when added as a submodule.
- `.cogni/secrets-catalog.yaml` + `k8s/external-secrets/` are intentionally absent (bug.5086 Part D: a node inherits baseline secrets via the substrate; declares its own only when it has unique ones).
- The root workspace includes the required private `@cogni/*` package closure so a generated child repo can install, typecheck, build, and push its own image without the operator monorepo.
- `.github/workflows/ci.yaml` builds the app image and, on `main`, pushes `ghcr.io/<owner>/cogni-node-template:sha-<childSha>`.
- The deploy/infra plane is intentionally absent: no candidate-flight, preview/prod promote, provision-env, Argo/AppSet, or parent infra workflows live here.

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm check
docker build --target runner -t cogni-node-template:local .
```

The operator consumes the pushed digest and owns URL/DNS/deployment state.
