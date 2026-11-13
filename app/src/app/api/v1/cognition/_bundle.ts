// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/cognition/_bundle`
 * Purpose: Pure composition of the session-start kickstart bundle — the
 *   irreducible tooling invariants (code-owned) plus the markdown renderer
 *   that frames local governing triggers and static operator navigation.
 * Scope: Pure functions + the invariants constant. No I/O, no env, no container.
 * Invariants:
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: the constant is the one piece of
 *     cognition that must render even when the hub is empty/unreachable.
 *   - ORIENTATION_LOADED_IN_FULL: renders pointers (id + title + recall path)
 *     for skills/domains, but the current-node `<slug>-agent-orientation` entry
 *     is rendered IN FULL — the bootstrap IS the agent's operating map, so the
 *     git skeleton stays minimal and the Dolt orientation carries the substance.
 *   - GOALS_AFTER_MISSION: the approved goals render as `## Goals` right after
 *     the orientation. The section text (zero-goal bootstrap instruction,
 *     `goals unavailable: …`) ships in `@cogni/knowledge-store`'s
 *     `renderGoalsLines`; this file is only the call site (story.5101).
 *   - ROUTE_BY_DOMAIN_AND_ARCHITECT: the Markdown carries no flat governing
 *     index. Agents route through the orientation, node-template-architect's
 *     subsystem table and the domain map; the JSON response keeps the complete
 *     governingIndex for programmatic readers (story.0044).
 * Side-effects: none
 * Links: docs/spec/node-baas-architecture.md
 * @internal
 */

import {
	type GoalsSection,
	renderGoalsLines,
	isGoverningEntryType,
} from "@cogni/knowledge-store";
import {
	OPERATOR_KNOWLEDGE_ORIGIN,
	OPERATOR_GUIDANCE_POINTERS,
	OPERATOR_KNOWLEDGE_SHELVES,
	COGNITION_CREDENTIAL_NAMES,
} from "@cogni/knowledge-base/cognition-navigation";
import type {
	CognitionGoverningPointer,
	CognitionDomainPointer,
	CognitionSkillPointer,
} from "@cogni/node-contracts";

/**
 * The irreducible session contract. This is the ONLY cognition that is
 * code-owned rather than hub-delivered: it must survive an empty or unreachable
 * hub so every session still bootstraps. Everything expandable (skills, guides,
 * domain expertise) is delivered live from the knowledge hub on top of this.
 */
export const SESSION_BOOTSTRAP_INVARIANTS: readonly string[] = [
	"GROUND. Never act on intuition. Act only on documented practice: this node's guides, skills, designs and roadmaps. Before any action, read the orientation, `node-template-architect`, and every governing atom it names, in full. If no guide covers the action, write or refine that guide first, in the same work item. A deliberate deviation also refines the guide first. Each work-item edit sends `cites` for the atoms you used.",
	"FOCUS. ONE work item and ONE node per session. Work only a triaged item: scored, goal-linked, with `moves` or a recorded measurement gap. Pick from the top five by rankScore, or take the item the CEO named. The item is your plan: claim it and keep its Done when checklist current. Its status gates the allowed action (status table in the agent-contract). Triage new work before anything else.",
	"PROVE. Ship the smallest change that moves the KPI, the same day. Done is a PASS /validate-candidate scorecard at the exact build SHA. Then read the moved KPI on production after one metric window, against its pinned baseline (`kpi-through-delivery`). Tests are CI hygiene, never proof.",
	"Ship via PR: branch → CI green → flight to candidate → /validate-candidate → operator merge → promote. Watch each async gate with <watch-gate> below.",
];

/**
 * How to watch an async CI/CD gate — the ONE portable technique, tagged for
 * machine parse + recall. Code-owned (survives an empty hub) and XML-structured
 * so any harness (Claude, Codex, OpenAI, plain shell) extracts the exact command
 * without prose parsing. Deliberately terse: five tagged atoms, no run-on prose.
 */
export const SESSION_WATCH_GATE = `<watch-gate rule="ONE blocking command; its exit code or matched value IS the verdict — no harness-specific monitor/background/notification primitive, never fire-and-forget, re-read the ground-truth signal before reporting">
  <ci-green>gh pr checks {PR} --watch --fail-fast — blocks; 0=all pass, nonzero=failed. NOT --required (omits real gates, e.g. build). Re-read after (one-shot 8=pending) — finished ≠ green.</ci-green>
  <flight-landed>poll curl -s {candidate}/version until .buildSha == PR-head SHA → then /validate-candidate. Bound it; no match = flight FAILED, report not hang. host: {node}-test.cognidao.org.</flight-landed>
  <deploy-landed>poll curl -s {target}/version until .buildSha == promoted SHA; bound, report on no-match. host: {node-}{preview,}cognidao.org.</deploy-landed>
  <truth>/version.buildSha is the only ground truth — CI and workflow "success" can lie.</truth>
</watch-gate>`;

/** Compatibility name; the shared store remains the sole membership-policy owner. */
export const isCognitionEntry = isGoverningEntryType;

function operatorNavigationLines(): string[] {
	const { node, operator, legacyOperator } = COGNITION_CREDENTIAL_NAMES;
	return [
		"## Operator guidance — explicit reads",
		"",
		`- Guides by intent, read with \`GET ${OPERATOR_KNOWLEDGE_ORIGIN}/api/v1/knowledge/{id}\`: ${OPERATOR_GUIDANCE_POINTERS.map((p) => `${p.intent} → \`${p.id}\``).join(" · ")}.`,
		`- Operator shelves (${OPERATOR_KNOWLEDGE_SHELVES.join(", ")}): \`GET ${OPERATOR_KNOWLEDGE_ORIGIN}/api/v1/knowledge/index?domain=<shelf>\`.`,
		`- Local hub key \`${node}\`; operator reads use \`${operator}\`, else \`${legacyOperator}\`. Never retry another key or host on 401/403. Check grants with GET /api/v1/agent/me; request node.flight, never self-approve.`,
		"",
	];
}

/** Make a string safe to drop into a GFM table cell (no `|`, no line breaks). */
export function escapeCell(value: string | null | undefined): string {
	return (value ?? "")
		.replace(/\s*\r?\n\s*/g, " ")
		.replace(/\|/g, "\\|")
		.trim();
}

/** The current-node orientation entry — rendered in full as the session map. */
export interface OrientationEntry {
	id: string;
	content: string;
}

export interface RenderBundleInput {
	governingIndex: readonly CognitionGoverningPointer[];
	node: string;
	name: string;
	mission: string | null;
	generatedAt: string;
	origin: string;
	buildSha: string;
	toolingInvariants: readonly string[];
	skillsIndex: readonly CognitionSkillPointer[];
	domainPointers: readonly CognitionDomainPointer[];
	/** The current node's `<slug>-agent-orientation` entry (full), or null if unseeded. */
	orientation: OrientationEntry | null;
	/** Approved goals (`listActiveGoals`), rendered right after the orientation. */
	goals: GoalsSection;
}

/**
 * Render the kickstart bundle as GFM markdown. A SessionStart hook echoes this
 * verbatim to stdout; Claude Code and Codex both inject SessionStart stdout
 * into the model's context.
 */
export function renderBundleMarkdown(input: RenderBundleInput): string {
	return renderWith(input);
}

function renderWith(input: RenderBundleInput): string {
	const {
		node,
		name,
		mission,
		generatedAt,
		origin,
		buildSha,
		toolingInvariants,
		orientation,
		goals,
	} = input;
	const { skillsIndex, domainPointers } = input;
	// "2026-06-16 14:20" — human date, not an ISO wall of digits.
	const loadedAt = generatedAt.replace("T", " ").slice(0, 16);
	const subtitle = [
		mission,
		`${skillsIndex.length} skills`,
		`${domainPointers.length} domains`,
		`loaded ${loadedAt}`,
	]
		.filter(Boolean)
		.join(" · ");

	const invariants = toolingInvariants
		.map((line, i) => `${i + 1}. ${line}`)
		.join("\n");

	// The node's candidate (pre-merge flight slot) — where "validated on
	// candidate" happens. operator is the primary test apex; every other node is
	// a slugged test host. Concrete so agents stop guessing the hostname.
	const candidateHost =
		name === "operator" ? "test.cognidao.org" : `${name}-test.cognidao.org`;

	const domainRows =
		domainPointers.length > 0
			? domainPointers
					.map(
						(d) =>
							`| \`${d.domain}\` | ${d.entryCount} | ${escapeCell(d.description)} |`,
					)
					.join("\n")
			: "| _(none)_ | | |";

	// The map, not just the constitution: the current-node orientation entry
	// rendered IN FULL — the bootstrap IS the orientation (no second recall).
	// Falls back to a seed prompt when unset so the convention surfaces even
	// before the entry exists.
	const orientationLines = orientation
		? ["## Orientation — recall this first", "", orientation.content]
		: [
				"## Orientation — recall this first",
				"",
				`_No \`${name}-agent-orientation\` entry yet. Recall the hub, then seed one — the current-node operating map for agents (what this node is, where authority lives, what's safe, what to recall next) — and refine it as the repo changes._`,
			];

	return [
		`# ${name} — Cogni Session Cognition`,
		"",
		`> ${subtitle}`,
		">",
		`> Delivered at session start from ${origin}/api/v1/cognition — replaces git-synced AGENTS.md sprawl. (node \`${node}\` · build \`${buildSha}\`)`,
		"",
		...orientationLines,
		...renderGoalsLines(goals),
		"",
		"## Tooling invariants",
		"",
		invariants,
		"",
		`_Your candidate (flight + validate target): \`https://${candidateHost}\` · Loki namespace \`cogni-candidate-a\`._`,
		"",
		"## Watch an async gate — CI · flight · deploy",
		"",
		SESSION_WATCH_GATE,
		"",
		...operatorNavigationLines(),
		"## Knowledge domains — recall before you write",
		"",
		`Browse \`GET ${origin}/api/v1/knowledge?domain=<domain>\`, read bodies with \`GET ${origin}/api/v1/knowledge/{id}\`. Refine in place over adding new: \`/contribute-knowledge-to-cogni\`.`,
		"",
		"| domain | entries | about |",
		"| --- | --- | --- |",
		domainRows,
		"",
		"## Work items — this node's own ledger",
		"",
		`- Goal KPIs, live (NO_GOAL_PROGRESS in the bundle): \`GET ${origin}/api/v1/metrics/goals\`.`,
		`- Top of the queue: \`GET ${origin}/api/v1/work/items?sortBy=rankScore&sortDirection=desc&limit=5&statuses=needs_triage,needs_research,needs_design,needs_implement,needs_closeout,needs_merge\`. Adopt over create.`,
		`- File one: \`POST ${origin}/api/v1/work/items\` \`{type,title,summary,outcome,moves}\` — \`type\` ∈ task|bug|story|spike|subtask; the server allocates the id and pins the KPI baseline.`,
		`- Progress: \`PATCH ${origin}/api/v1/work/items/{id}\` \`{"reason":"<why, at most 25 words>","cites":[{"id":"<atom>"}],"set":{...}}\` — \`reason\` is required and lives in history; the wrapper is \`set\`. Schemas: \`GET ${origin}/.well-known/agent.json\`.`,
		"",
	].join("\n");
}
