---
description: Add a node-owned secret declaration and typed code consumption.
---

Read `docs/guides/add-secret.md`, then implement only the node-repo half:

1. Add or update `.cogni/secrets-catalog.yaml`.
2. Add typed env validation where app code reads the key.
3. Do not write the secret value.
4. Do not edit operator deploy overlays, pod specs, or ExternalSecret resources.
5. Run `pnpm check`.
