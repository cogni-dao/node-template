---
id: guide.contributing-to-cogni
type: guide
title: Contribute to a Cogni Node
status: draft
trust: draft
summary: Practical contribution loop for agents and humans working inside a node-template repo.
read_when: Starting implementation work in a Cogni node repo.
owner: derekg1729
created: 2026-06-05
verified: null
tags: [agents, contributing, nodes]
---

# Contribute to a Cogni Node

This repo is a node-at-root Cogni node. The node owns app code, packages, graphs, review policy, and CI. The operator monorepo owns deploy infrastructure and pins this repo as a submodule.

## Loop

1. Read root `AGENTS.md`, then the closest `AGENTS.md` for the files you will touch.
2. Keep the PR scoped to one node concern.
3. Reuse existing patterns before adding abstractions.
4. Implement on a branch.
5. Run local checks:

   ```bash
   pnpm check
   ```

6. Open a PR against `main`.
7. Watch CI and fix file-scoped failures.
8. Let the operator side handle deploy flighting once the node commit is pinned.

## Boundaries

Owned in this repo:

- `app/`
- `graphs/`
- `packages/`
- `.cogni/repo-spec.yaml`
- `.cogni/rules/`
- `.cogni/secrets-catalog.yaml` when the node has unique secrets
- `.github/workflows/`
- `Dockerfile`

Not owned here:

- Operator environment overlays
- Argo ApplicationSets
- DNS records
- OpenBao value writes
- Candidate/preview/production deploy branches in the operator monorepo

## Pull Request Bar

- One coherent outcome.
- Strictly typed boundaries.
- No secret values in git or logs.
- `pnpm check` passes.
- UI changes include responsive visual verification.
- New reusable knowledge goes to the node knowledge guide, not inline comments or sprawling markdown.
