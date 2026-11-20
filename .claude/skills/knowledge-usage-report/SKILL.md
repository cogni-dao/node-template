---
name: knowledge-usage-report
description: Report how one node's agents use its knowledge. Use for a weekly knowledge review, for which atoms agents read most, which atom ids they ask for that do not exist, how knowledge reads and writes succeed or fail and why, or which atoms to fix or review next.
---

# knowledge-usage-report

This file is only the trigger. The knowledge hub is the authoritative, refinable contract.

Read these node-owned entries with `COGNI_NODE_API_KEY`, then follow them:
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-usage-report`
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-usage-telemetry`

Do not reconstruct or preserve a fallback copy in this repository.
