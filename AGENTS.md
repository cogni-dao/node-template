# AGENTS.md — Your Cogni Node

> This repo is a **Cogni node** minted from `node-template`. It is a sovereign
> repo: your code lives and is built here, in its own git boundary. A shared
> **operator** monorepo pins this repo as a submodule and runs the deploy/infra
> plane for you — you never edit the operator's `infra/catalog`, run
> `provision-env`, or touch Argo. See `docs/spec/node-ci-cd-contract.md` in the
> operator monorepo for the full two-views model.

## Your cognition is delivered at session start

A SessionStart hook ([`.claude/settings.json`](.claude/settings.json) for Claude Code,
[`.codex/config.toml`](.codex/config.toml) for Codex) runs the shared loader
[`scripts/agent/session-cognition.sh`](scripts/agent/session-cognition.sh), which pulls a
**cognition bundle** — tooling invariants + a live skills index + knowledge-domain pointers —
and injects it into context. Codex needs a one-time trust (`/hooks`).

- The loader derives `https://<node-slug>.cognidao.org/api/v1/cognition` from
  `.cogni/repo-spec.yaml` `intent.name`; there is no `COGNI_COGNITION_URL`
  override. If this node's own hub is not deployed yet, it falls back to the
  operator (`https://cognidao.org/api/v1/cognition`) for the shared Cogni agent
  contract.
- Self-serve any time cognition does not load: register once with
  `POST https://cognidao.org/api/v1/agent/register`, save `COGNI_API_KEY=<apiKey>`
  in `.env.cogni`, then retry. Conductor setup symlinks `.env.cogni` into future
  worktrees, so spawned sessions need no per-worktree key export.
- Manual fetch shape (cognition needs a principal): `curl -fsS -H "Authorization: Bearer $COGNI_API_KEY" "https://cognidao.org/api/v1/cognition" | jq -r .markdown`.
- This node serves its own bundle at `GET /api/v1/cognition` (authed, index-only — needs a principal; `/api/v1/agent/register` stays the one public bootstrap seam).

## What you own (node-dev half)

- **App + graphs + packages** at the repo root.
- **Your CI** (`.github/workflows/`), policy (`biome`, `tsconfig`, `.dependency-cruiser.cjs`), and `Dockerfile` — `POLICY_STAYS_LOCAL`. Your CI builds + pushes your own image (`FORK_FREEDOM`).
- **Review policy**: `.cogni/repo-spec.yaml` `gates:` + `.cogni/rules/`. A PR here routes + reviews against these (born-reviewable). Tune the gate set to your node's mission.

## Add a secret (node-dev half)

Declare the key's **shape** in `.cogni/secrets-catalog.yaml` and consume it via typed env in app code (fail-fast if missing). You do **not** set the value or wire the ExternalSecret — whoever owns the deploy env does that (`pnpm secrets:set <env> <slug> <KEY>`).

Use [`docs/guides/add-secret.md`](docs/guides/add-secret.md) or `/add-secret` for the node-local checklist.

## Customize node identity

Use [`docs/guides/new-node-styling.md`](docs/guides/new-node-styling.md) when changing the node logo, colors, metadata, public page, or chat defaults.

## Contribution + knowledge

Use [`docs/guides/contributing-to-cogni.md`](docs/guides/contributing-to-cogni.md) or `/contribute-to-cogni` for the node contribution loop. Use [`docs/guides/contribute-knowledge.md`](docs/guides/contribute-knowledge.md) or `/contribute-knowledge` before preserving reusable findings.

## Add a service (node-dev half)

App code + `Dockerfile` + a k8s **base** manifest + the **build→GHCR** workflow leg, all here. Your CI builds + pushes the image. The operator's plane generates the per-env overlay/AppSet/catalog row that references your pushed digest.

> The full operator-side guides (`create-service`, `secrets-add-new`) live in the
> operator monorepo and are the reference for the deploy-env half.
