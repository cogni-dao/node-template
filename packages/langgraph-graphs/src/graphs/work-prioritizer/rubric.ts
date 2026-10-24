// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/rubric`
 * Purpose: One mission rubric shared by proposal author and independent verifier.
 * Scope: Semantic anchors only; score validation and ranking belong to work-items.
 * Invariants: Unknown is zero; independent dimensions; source contents justify each axis.
 * Side-effects: none
 * Links: work-item-scores-design, contribution b51a450c sequence10, task.5333
 * @internal
 */
export const MISSION_SCORE_AXES = [
  "goal",
  "time",
  "unblocks",
  "ease",
  "confidence",
  "agent",
] as const;

export const MISSION_SCORE_RUBRIC = `Assess all six axes independently. Zero or a missing stored axis means unknown, never low value or zero rank. This proposal format requires all six axes: represent unknown exactly as {v:0}, never {} or an omitted axis. Each support entry must cite at least one actual inspected receipt, even when explaining uncertainty: the receipt shows the limited information inspected, not proof of the absent fact. Do not invent evidence or lower a score merely to pass validation. Evidence-child findings should report facts and uncertainty, not propose a scores JSON template.
- goal: 5 = central lever for an active goal's KPI; 1 = no goal fit.
- time: 5 = harm or expiry within days, value decays fast; 1 = no time pressure.
- unblocks: 5 = other top work waits on it or it removes a live risk; 1 = unblocks nothing.
- ease: 5 = one complete edit → CI → flight → validate iteration, ≤30m; 4 = 1–2 iterations; 3 = 2–3; 2 = 4–6; 1 = exceeds one-day appetite, decompose first. Estimate in agent iterations, never days.
- confidence: 5 = verified live today, no fix already merged, scope clear; 1 = stale text, unverified. Confidence comes from current primary evidence, not self-report.
- agent: 5 = an agent can finish and prove it automatically, reversibly; 1 = human money, credentials or judgment, or irreversible. An unresolved human/credential/judgment gate requires 1–2. Small scope alone does not establish autonomy.
A title, stated goal, or popularity does not establish urgency, dependencies, effort, verified confidence or autonomy. Each 4–5 needs an absolute safe HTTPS Justification URL (ev) whose supporting contents were actually read this run. Any hostname/source class can qualify; unavailable contents cannot. Never use the scored item's own URL as ev, even on low scores. Omit optional ev when no qualifying independent source was read. Keep per-axis rationale and primary evidence receipt IDs separately in support.
The canonical work-items package validates scores and computes rankScore. Never calculate or invent rankScore; missing/zero axes make it unknown. Agent <3 or unknown belongs to the human queue, agent >=3 to the agent queue; package-computed rank orders each. Evaluation never changes priority, rank or legacy estimate.`;
