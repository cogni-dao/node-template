---
id: guide.add-secret
type: guide
title: Add a Node Secret
status: draft
trust: draft
summary: Node-repo half of adding a node-specific secret without touching operator deploy plumbing.
read_when: Adding a credential or API key that this node's app code consumes.
owner: derekg1729
created: 2026-06-05
verified: null
tags: [secrets, nodes]
---

# Add a Node Secret

A node developer owns the secret declaration and typed consumption. The deploy-env owner writes the value and reconciles the pod.

## Secret or Plain Config

Use this guide only for credentials: API keys, tokens, webhook secrets, private signing material, and passwords.

Plain non-sensitive config belongs in typed app config and the operator-owned deployment overlay, not in a secrets catalog.

## 1. Declare the Shape

If `.cogni/secrets-catalog.yaml` does not exist, create it. Add one entry for the node-owned key:

```yaml
- name: MY_NEW_KEY
  tier: A2
  appliesTo: web
  shared: false
  source: human
  required: true
  category: "Vendor Name"
  description: One line describing what consumes this key.
  steps:
    - "Create the key in the vendor dashboard."
```

Use `source: agent` only for values that automation can generate safely. Use `source: human` for vendor credentials.

## 2. Consume It in Code

Read `process.env.MY_NEW_KEY` through the node's typed env boundary. Required secrets must fail fast at startup if missing. Do not silently continue with `undefined`.

Do not log secret values, request headers, tokens, cookies, or full vendor payloads.

## 3. Value Write

The value does not enter git, PR comments, chat, or committed YAML.

For Cogni-managed deploy environments, the deploy-env owner writes the value through the operator-side OpenBao path:

```bash
pnpm secrets:set <env> <node-slug> MY_NEW_KEY
```

The operator side owns ExternalSecret wiring, pod `envFrom`, DB/DNS provisioning, and rollout. A node PR should not edit those surfaces.

## What Not to Touch

- Do not commit a Kubernetes `Secret`.
- Do not add a per-key `valueFrom` line to a pod spec.
- Do not create a per-key ExternalSecret YAML.
- Do not paste the value into a PR, issue, chat, or shell history.
- Do not edit operator `infra/catalog`, Argo, or environment overlays from this node repo.

## PR Proof

- `.cogni/secrets-catalog.yaml` declares the key shape.
- The typed env boundary validates the key if code requires it.
- Tests or startup checks prove missing required config fails loudly.
- `pnpm check` passes.
