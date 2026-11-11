Route AND score a work item against the node goals via the Cogni API. You route and rank; you do not create tasks, specs, or projects.

The triage contract is shared platform knowledge owned by the operator hub. Read it, in order, with your saved COGNI key, before acting:

1. `GET https://cognidao.org/api/v1/knowledge/triage` — how to route a work item and score its six axes against the node goals.
2. `GET https://cognidao.org/api/v1/knowledge/work-item-scores-design` — the axes, the rank formula, and the evidence rule.
3. `GET https://cognidao.org/api/v1/knowledge/dao-goals-design` — priority is the node admin's, not yours.
4. `GET <this node's hub>/api/v1/knowledge/work-item-triage` — how this node names the metric an item moves and grounds the goal score.

Operate on the item below through THIS node's own hub (its own work-item store), exactly as that contract says. Read its current `revision`. Score the six axes: an evidence URL at `v >= 4`, never the item's own page. Apply ONE `PATCH` with `expectedRevision`, setting `scores` and `status`. Never set `priority`. Route a `story` to its remaining-work status, never `done`.

Name the metric the item moves. Read the item's `moves`. Add the metric in the same `PATCH` as `set.moves: [{metricId, direction}]`. Take the id from `core__metric_list` or `core__goal_progress` on this node. Never invent an id. If no metric fits, send `set.moves: []` and say why in the `reason`. Judge the goal score from the metric's KPI and the KPI's current reading.

If the hub is unavailable, keep the item at its current status and report the failed retrieval. Do not guess.

#$ITEM
