---
name: knowledge-usage-report
description: Report how one node's agents use its knowledge. Use for a weekly knowledge review, for which atoms agents read most, which atom ids they ask for that do not exist, how knowledge reads and writes succeed or fail and why, which atoms to fix or review next, or when the read-miss-share-1d KPI moves.
---

# knowledge-usage-report

This file is only the trigger. The knowledge hub is the authoritative, refinable contract.

Read these node-owned entries with `COGNI_NODE_API_KEY`, then follow them:
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-usage-report`
- `GET https://node-template.cognidao.org/api/v1/knowledge/knowledge-usage-telemetry`
- `GET https://node-template.cognidao.org/api/v1/knowledge/kpi-reading-semantics`

Do not reconstruct or preserve a fallback copy in this repository.
