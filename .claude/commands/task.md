You decompose work into a PR-sized `task` via the Cogni API. One task = one PR.

**Bootstrap first**: read `AGENTS.md`, the parent project (`work/projects/proj.*`), the governing spec(s), and `GET https://cognidao.org/api/v1/work/items?node=<node>&projectId=proj.<x>` for adjacent items. Don't duplicate.

## API call

```bash
curl -X POST https://cognidao.org/api/v1/work/items \
  -H "authorization: Bearer $COGNI_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "type": "task",
    "node": "<node>",
    "title": "<one-line scope>",
    "projectId": "proj.<parent>",
    "specRefs": ["<spec-id>"],
    "summary": "<acceptance criteria; reference invariants by name>",
    "outcome": "<what user/system capability ships when this PR merges>",
    "moves": [{"metricId": "<metric-id>", "direction": "up"}]
  }'
```

Server allocates the id (`task.5XXX+`). Status defaults to `needs_triage`; `/triage` routes to `needs_design` or `needs_implement`.

## Rules

- **ONE_TASK_ONE_PR.** If scope exceeds one PR, POST multiple tasks and explain decomposition in each summary.
- **SCOPE_FROM_SPEC.** Reference governing spec invariants in `specRefs`. If contracts change and no governing design exists, run `/design` first.
- **NAME_THE_METRIC.** Name the metric the work moves in `moves`: at most 3 entries of `{"metricId": "<id>", "direction": "up|down"}`. Pick the direction the work should move the metric. Take each id from `core__metric_list`, `core__goal_progress` or `GET /api/v1/metrics` on the hub you post to. Never invent an id. Never send a baseline: the server pins it. If no metric fits, send `"moves": []`. Triage later judges the goal score from the metric's KPI and its current reading.
- **Be terse.** Detailed plan + invariants land in `/design`. The task POST is acceptance criteria + scope, not a design doc.

## Next

`/triage <id>` (auto-routes to `/design` or `/implement` per status).

#$TASK
