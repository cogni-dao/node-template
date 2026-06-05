---
name: contribute-to-cogni
description: Contribution loop for agents working in a Cogni node-template repo. Use when starting implementation, preparing a PR, or checking node/operator ownership boundaries.
---

# Contribute to Cogni

Read `docs/guides/contributing-to-cogni.md` and root `AGENTS.md`.

Core contract:

- Work in this node repo's ownership boundary.
- Keep one coherent PR outcome.
- Do not edit operator deploy infrastructure from the node repo.
- Declare node-owned secret shapes in `.cogni/secrets-catalog.yaml`; never write secret values into git.
- Run `pnpm check` before publishing.
- If the change produces durable reusable knowledge, use `contribute-knowledge-to-cogni`.
