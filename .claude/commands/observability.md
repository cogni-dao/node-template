---
description: Observability finish pass — add minimal, high-signal logging/metrics for the changes in this branch (post-PR, no refactors).
---

# Observability Finish Pass

Read the operator-owned [node-observability-finish-pass](https://cognidao.org/knowledge/node-observability-finish-pass) guide before touching code, then follow it for the changes in this branch. Use your saved operator-issued key:

```bash
set -o pipefail
: "${COGNI_OPERATOR_NODE_API_KEY:?Load your saved operator Cogni API key}"
curl -fsS --max-time 30 \
  -H "Authorization: Bearer $COGNI_OPERATOR_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/node-observability-finish-pass \
  | jq -er '.content | select(type == "string" and length > 0)'
```

Read `content`; stop if the fetch fails and report it. Read signals back with [node-service-logs-read](https://cognidao.org/knowledge/node-service-logs-read) (`/logs`). Instrument only the layer this branch changed, with no refactors and no observability redesign. Put events, metrics, and the `nodeId` check in the PR description.
