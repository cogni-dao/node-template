---
description: Add or improve high-ROI tests for the changed files on the current branch.
---

# test

Read the node-template-owned [node-test-contract](https://node-template.cognidao.org/knowledge/node-test-contract) before writing tests, then follow it for the files this branch changed. Use your saved node-template key (on node-template itself, `COGNI_NODE_API_KEY`):

```bash
set -o pipefail
: "${COGNI_NODE_TEMPLATE_API_KEY:?Load your saved node-template Cogni API key}"
curl -fsS --max-time 30 \
  -H "Authorization: Bearer $COGNI_NODE_TEMPLATE_API_KEY" \
  https://node-template.cognidao.org/api/v1/knowledge/node-test-contract \
  | jq -er '.content | select(type == "string" and length > 0)'
```

Read `content`; stop if the fetch fails and report it. Target only files changed on this branch, pick the smallest layer that proves the behavior, and stop when added coverage is low ROI. Follow AGENTS.md local-execution limits: no heavy aggregate checks without the human's explicit request.
