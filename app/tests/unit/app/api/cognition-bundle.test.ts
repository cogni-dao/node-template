// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/cognition-bundle`
 * Purpose: Unit tests for the cognition bundle markdown renderer.
 * Scope: Pure rendering only; route IO and hub reads are validated separately.
 * Invariants: Session-start heading is human node identity first, deploy SHA as metadata.
 * Side-effects: none
 * Links: src/app/api/v1/cognition/_bundle.ts
 * @public
 */

import {
	GOALS_BOOTSTRAP_INSTRUCTION,
	resolveGoals,
} from "@cogni/knowledge-store";
import { describe, expect, it, vi } from "vitest";
import {
	renderBundleMarkdown,
	resolveOrientation,
	SESSION_BOOTSTRAP_INVARIANTS,
	SESSION_WATCH_GATE,
} from "@/app/api/v1/cognition/_bundle";

const baseInput = {
	node: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
	name: "operator",
	mission: "Coordinate code, deploys, and validation for Cogni nodes.",
	generatedAt: "2026-06-16T19:31:02.838Z",
	origin: "https://test.cognidao.org",
	buildSha: "f52036b33ffecdf5244662e673a0d6d174c50150",
	toolingInvariants: ["Adopt one production work item."],
	skillsIndex: [
		{
			id: "node-launch-handoff",
			title: "Node launch handoff",
			entryType: "guide",
			domain: "infrastructure",
		},
	],
	governingIndex: [
		{
			id: "node-launch-handoff",
			domain: "infrastructure",
			entryType: "guide",
			useWhen: "launch a node",
		},
	],
	domainPointers: [
		{
			domain: "infrastructure",
			entryCount: 7,
			description: "Runtime and deploy knowledge.",
		},
	],
	orientation: null,
	goals: { status: "ok", goals: [] },
} as const;

describe("renderBundleMarkdown", () => {
	it("renders name, mission, counts, and load time while demoting build SHA", () => {
		const markdown = renderBundleMarkdown(baseInput);

		const [heading, blank, subtitle, spacer, delivered] = markdown.split("\n");

		expect(heading).toBe("# operator — Cogni Session Cognition");
		expect(blank).toBe("");
		expect(subtitle).toBe(
			"> Coordinate code, deploys, and validation for Cogni nodes. · 1 skills · 1 domains · loaded 2026-06-16 19:31",
		);
		expect(spacer).toBe(">");
		expect(delivered).toContain("node `4ff8eac1-4eba-4ed0-931b-b1fe4f64713d`");
		expect(delivered).toContain(
			"build `f52036b33ffecdf5244662e673a0d6d174c50150`",
		);
		expect(heading).not.toContain("f52036b3");
	});

	it("surfaces the derived candidate (flight + validate) URL for the node", () => {
		// operator is the primary test apex...
		expect(renderBundleMarkdown(baseInput)).toContain(
			"https://test.cognidao.org",
		);
		// ...every other node is a slugged test host.
		expect(renderBundleMarkdown({ ...baseInput, name: "poly" })).toContain(
			"https://poly-test.cognidao.org",
		);
	});

	it("always renders the node-relative work-item write seam", () => {
		const markdown = renderBundleMarkdown({
			...baseInput,
			name: "poly",
			origin: "https://poly.cognidao.org",
			orientation: {
				id: "poly-agent-orientation",
				content: "Poly node operating map.",
			},
		});

		expect(markdown).toContain("## Work items — this node's own ledger");
		expect(markdown).toContain(
			"POST https://poly.cognidao.org/api/v1/work/items",
		);
		expect(markdown).toContain(
			"PATCH https://poly.cognidao.org/api/v1/work/items/{id}",
		);
		expect(markdown).toContain('{"set":{...}}');
	});

	it("renders the current-node orientation entry IN FULL above the tooling invariants", () => {
		const fullOrientation = [
			"**USE WHEN:** first read of every operator session.",
			"",
			"## Mission",
			"Operator is the agentic git-manager. Edit nodes/operator/app.",
			"",
			"## Principles",
			"- Recall before write, refine over extend.",
		].join("\n");
		const markdown = renderBundleMarkdown({
			...baseInput,
			orientation: {
				id: "operator-agent-orientation",
				content: fullOrientation,
			},
		});

		expect(markdown).toContain("## Orientation — recall this first");
		// The whole entry body is inlined, not a truncated excerpt — every section
		// survives, including ones past the old 480-char first-paragraph cut.
		expect(markdown).toContain(fullOrientation);
		expect(markdown).toContain("## Mission");
		expect(markdown).toContain("- Recall before write, refine over extend.");
		// No second-recall footer: the bootstrap IS the orientation.
		expect(markdown).not.toContain("for the full context");
		// Map comes before the constitution.
		expect(markdown.indexOf("## Orientation — recall this first")).toBeLessThan(
			markdown.indexOf("## Tooling invariants"),
		);
	});

	// The bundle is served to every harness (Claude Code, Codex, OpenAI, plain
	// shell) and auto-injected into a fresh session. So the "how to watch an async
	// gate" contract must be (a) portable — one blocking shell command, no
	// Claude-only Monitor/background primitive — and (b) XML-tagged so any model
	// parses + recalls the exact command without prose parsing. Pin both here.
	it("exposes a portable, XML-tagged watch-gate the render inlines", () => {
		const g = SESSION_WATCH_GATE;
		// Tag-structured: five parseable atoms, not a prose run-on.
		expect(g).toContain("<watch-gate");
		expect(g).toContain("</watch-gate>");
		expect(g).toContain("<ci-green>");
		expect(g).toContain("<flight-landed>");
		expect(g).toContain("<deploy-landed>");
		expect(g).toContain("<truth>");
		// Portable, harness-neutral rule lives on the opening tag.
		expect(g).toContain("ONE blocking command");
		expect(g).toContain("no harness-specific monitor/background");
		// (1) CI: exact one-liner + the --required trap.
		expect(g).toContain("gh pr checks {PR} --watch --fail-fast");
		expect(g).toContain("NOT --required");
		// Verified against PR #2075: `static` IS a required check, so the reason to
		// avoid --required is the gates it OMITS (e.g. build), not static. Don't let
		// the stale "build/static live outside required" claim creep back.
		expect(g).not.toMatch(/build\/static/);
		// --watch blocks to a terminal state and never returns 8; exit 8 (pending)
		// belongs only to the one-shot re-read. Guard against re-mislabeling it.
		expect(g).toMatch(/one-shot 8=pending/);
		// Poll must be bounded + fail loud — never an unbounded/​silent hang.
		expect(g).toMatch(/[Bb]ound/);
		expect(g).toContain("FAILED");
		// Placeholders are brace-form so the ONLY angle brackets are real tags —
		// an angle-bracket placeholder (<PR>) would collide with the tag grammar.
		expect(g).not.toMatch(/<(PR|candidate|target|node)>/);
		// (2)/(3) flight + deploy: /version.buildSha is the ground-truth verdict.
		expect(g).toContain(".buildSha");
		expect(g).toContain("only ground truth");
		// Terse by contract: the whole block must stay short enough to recall.
		expect(g.length).toBeLessThan(1000);
		// The render actually inlines it under a discoverable header.
		const markdown = renderBundleMarkdown(baseInput);
		expect(markdown).toContain("## Watch an async gate — CI · flight · deploy");
		expect(markdown).toContain(SESSION_WATCH_GATE);
	});

	it("keeps the CICD-sequence invariant free of the watch mechanics it delegates", () => {
		const cicd = SESSION_BOOTSTRAP_INVARIANTS.find((line) =>
			line.startsWith("Ship via PR"),
		);
		// The step order lives in the invariant; the *how to watch* lives in the
		// <watch-gate> block. The invariant points at it, never duplicates the cmd.
		expect(cicd).toBeDefined();
		expect(cicd).not.toContain("--fail-fast");
		expect(cicd).toContain("<watch-gate>");
	});

	it("prompts seeding an orientation entry when none exists", () => {
		const markdown = renderBundleMarkdown(baseInput);

		expect(markdown).toContain("## Orientation — recall this first");
		expect(markdown).toContain("No `operator-agent-orientation` entry yet");
	});
});

describe("bundle growth — whole indexes below the Markdown budget (task.5309)", () => {
	// A realistic index past the former 16 KiB ceiling still fits the reviewed
	// 64 KiB Markdown budget. Larger indexes use the same-node complete-index
	// fallback covered below; native harness delivery remains unchanged.
	function indexOf(rows: number, titleLen: number) {
		return Array.from({ length: rows }, (_, i) => ({
			id: `build-compute-entry-${i}`,
			// Trigger text carries the bulk of each content-free governing row.
			useWhen: `Build/compute runtime knowledge entry ${i} — ${"detail ".repeat(titleLen)}`,
			entryType: "guide",
			domain: "infrastructure",
		}));
	}

	it("renders a bundle well past the former 16 KB cap, whole and untruncated", () => {
		const md = renderBundleMarkdown({
			...baseInput,
			governingIndex: indexOf(80, 40),
		});
		const bytes = new TextEncoder().encode(
			`${md.replace(/\n+$/, "")}\n`,
		).byteLength;
		// Past the old ceiling — which would have thrown here.
		expect(bytes).toBeGreaterThan(16 * 1024);
		// The last row is present ⇒ nothing was dropped.
		expect(md).toContain("build-compute-entry-79");
	});
});

describe("resolveOrientation", () => {
	const port = (rows: Record<string, string>) => ({
		getKnowledge: async (id: string) =>
			id in rows ? { id, content: rows[id] } : null,
	});

	it("finds the exact-id entry even when the domain scan missed it (bug.5280)", async () => {
		// Repro: domain outgrew PER_DOMAIN_LIMIT, so the scan never saw the old
		// orientation row and passed scannedOrientationId=null. Direct lookup
		// must still resolve it.
		const result = await resolveOrientation(
			port({ "operator-agent-orientation": "the map" }),
			"operator-agent-orientation",
			null,
		);
		expect(result).toEqual({
			id: "operator-agent-orientation",
			content: "the map",
		});
	});

	it("falls back to the scan-found suffix entry when the exact id is absent", async () => {
		const result = await resolveOrientation(
			port({ "legacy-agent-orientation": "older map" }),
			"operator-agent-orientation",
			"legacy-agent-orientation",
		);
		expect(result?.id).toBe("legacy-agent-orientation");
	});

	it("falls back to the generic starter seed last, else null", async () => {
		const seeded = await resolveOrientation(
			port({ "cogni-agent-orientation": "starter" }),
			"operator-agent-orientation",
			null,
		);
		expect(seeded?.id).toBe("cogni-agent-orientation");

		const empty = await resolveOrientation(
			port({}),
			"operator-agent-orientation",
			null,
		);
		expect(empty).toBeNull();
	});
});

describe("Goals section — approved goals right after the orientation (story.5101)", () => {
	const port = (
		goals: {
			id: string;
			title: string;
			content: string;
			evaluateAt: Date | null;
		}[],
	) => ({ listActiveGoals: async () => goals });

	it("zero goals renders `no approved goals` plus the bootstrap instruction", async () => {
		const md = renderBundleMarkdown({
			...baseInput,
			goals: await resolveGoals(port([])),
		});
		expect(md).toContain(`## Goals\n\n${GOALS_BOOTSTRAP_INSTRUCTION}\n`);
		expect(md).toContain("no approved goals");
	});

	it("renders a goal after the orientation and before the invariants", async () => {
		const md = renderBundleMarkdown({
			...baseInput,
			orientation: { id: "node-agent-orientation", content: "the map" },
			goals: await resolveGoals(
				port([
					{
						id: "goal-g1",
						title: "Goal: outcome 1",
						content: "Statement: s1.",
						evaluateAt: new Date("2026-12-01T00:00:00.000Z"),
					},
				]),
			),
		});
		expect(md).toContain(
			"### Goal: outcome 1\n\nBy: 2026-12-01 · `goal-g1`\n\nStatement: s1.",
		);
		expect(md).not.toContain("no approved goals");
		const at = (needle: string) => md.indexOf(needle);
		expect(at("the map")).toBeLessThan(at("## Goals"));
		expect(at("## Goals")).toBeLessThan(at("## Tooling invariants"));
	});
});

describe("static platform discovery beside node-owned cognition (task.5309)", () => {
	it("routes an empty fresh hub to canonical trace/eval authorities without copying bodies", () => {
		const markdown = renderBundleMarkdown({
			...baseInput,
			name: "fresh-node",
			origin: "https://fresh-node.cognidao.org",
			skillsIndex: [],
			domainPointers: [],
			governingIndex: [],
		});
		for (const id of [
			"node-ai-traces-read",
			"agent-evaluation-loop",
			"langfuse-eval-expert",
		])
			expect(markdown).toContain(`https://cognidao.org/api/v1/knowledge/${id}`);
		for (const shelf of [
			"use-access",
			"use-ship",
			"use-operate",
			"use-govern",
			"method",
			"build-agents",
			"build-health",
		])
			expect(markdown).toContain(shelf);
		expect(markdown).toContain("COGNI_OPERATOR_NODE_API_KEY");
		expect(markdown).toContain("COGNI_OPERATOR_API_KEY");
		expect(markdown).toContain("COGNI_NODE_API_KEY");
		expect(markdown).toContain("/api/v1/agent/me");
		expect(markdown).toContain("node.flight");
		expect(markdown).toContain("fresh-node");
		expect(markdown).not.toContain("Basic ");
	});

	it("falls back to the same node's complete cognition index while preserving mandatory local bytes", () => {
		const orientation = `CUSTOM LOCAL MISSION AND OPERATING RULES ${"orientation ".repeat(200)}`;
		const rows = Array.from({ length: 100 }, (_, i) => ({
			id: `old-rule-${i}`,
			domain: "strategy",
			entryType: "rule",
			useWhen: `trigger ${i} ${"detail ".repeat(150)}`,
		}));
		rows.push({
			id: "method-rule",
			domain: "method",
			entryType: "rule",
			useWhen: "review a design",
		});
		const markdown = renderBundleMarkdown({
			...baseInput,
			name: "fresh-node",
			origin: "https://fresh-node.cognidao.org",
			governingIndex: rows,
			orientation: { id: "fresh-node-agent-orientation", content: orientation },
			goals: {
				status: "ok",
				goals: [
					{
						id: "goal-local",
						title: "Local approved goal",
						content: "LOCAL GOAL BYTES",
						evaluateAt: null,
					},
				],
			},
		});
		expect(markdown).toContain(
			"GET https://fresh-node.cognidao.org/api/v1/cognition",
		);
		expect(markdown).toContain("governingIndex");
		expect(markdown).toContain("method-rule");
		expect(markdown).not.toContain("old-rule-99");
		expect(markdown).toContain(orientation);
		expect(markdown).toContain("LOCAL GOAL BYTES");
		expect(markdown).toContain(baseInput.mission);
		expect(markdown).toContain(baseInput.toolingInvariants[0]);
		expect(markdown).toContain("node-ai-traces-read");
		expect(new TextEncoder().encode(markdown).byteLength).toBeLessThanOrEqual(
			64 * 1024,
		);
	});
});

const composition = vi.hoisted(() => ({ port: undefined as unknown }));
vi.mock("@/bootstrap/container", () => ({
	getContainer: () => ({
		nodeId: "fresh-uuid",
		knowledgeStorePort: composition.port,
	}),
}));
vi.mock("@/bootstrap/http", () => ({
	wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/shared/config", () => ({
	getNodeName: () => "fresh-node",
	getNodeMission: () => "Node-owned mission",
}));
vi.mock("@/shared/env", () => ({
	serverEnv: () => ({ APP_BUILD_SHA: "fixture-sha" }),
}));

it("composes the complete local governing response beyond the capped orientation scan without remote fetch or writes", async () => {
	const rows = Array.from({ length: 60 }, (_, i) => ({
		id: `rule-${i}`,
		domain: "method",
		entryType: "rule",
		useWhen: `when ${i}`,
	}));
	const list = vi.fn(async () => rows);
	const read = vi.fn(async () => null);
	composition.port = {
		listDomainsFull: async () => [
			{ id: "method", entryCount: 100, description: null },
		],
		listKnowledge: async () => [],
		listGoverningIndex: list,
		getKnowledge: read,
		listActiveGoals: async () => [],
	};
	const fetcher = vi.fn(() => {
		throw new Error("operator boot fetch forbidden");
	});
	vi.stubGlobal("fetch", fetcher);
	vi.stubEnv("COGNI_OPERATOR_NODE_API_KEY", "private-canonical-sentinel");
	vi.stubEnv("COGNI_OPERATOR_API_KEY", "private-legacy-sentinel");
	try {
		const { GET } = await import("@/app/api/v1/cognition/route");
		const handler = GET as unknown as (...args: unknown[]) => Promise<Response>;
		const response = await handler(
			{ log: { info: vi.fn(), warn: vi.fn() } },
			new Request("https://fresh-node.cognidao.org/api/v1/cognition"),
			{ id: "own-agent" },
		);
		const body = await response.json();
		expect(body.governingIndex).toEqual(rows);
		expect(body.skillsIndex).toHaveLength(60);
		expect(body.skillsIndex[59]).toMatchObject({
			id: "rule-59",
			title: "when 59",
		});
		expect(body.markdown).toContain("rule-59");
		expect(body.markdown).toContain("node-ai-traces-read");
		expect(JSON.stringify(body)).not.toContain("private-canonical-sentinel");
		expect(JSON.stringify(body)).not.toContain("private-legacy-sentinel");
		expect(fetcher).not.toHaveBeenCalled();
		expect(list).toHaveBeenCalledOnce();
		expect(response.headers.get("cache-control")).toContain("private");
	} finally {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	}
});

it("serves mandatory local cognition intact with an explicit over-budget condition", async () => {
	const content = "MANDATORY ".repeat(8000);
	const { renderBundle } = await import("@/app/api/v1/cognition/_bundle");
	const result = renderBundle({
		...baseInput,
		orientation: { id: "custom", content },
	});
	expect(result.markdown).toContain(content);
	expect(result.markdown).toContain("node-ai-traces-read");
	expect(result.governingRender.overBudget).toBe(true);
	expect(result.markdown).toContain("preserved whole");
});

it("falls back again when the method shelf itself is too large, without losing mandatory guidance", () => {
	const rows = Array.from({ length: 100 }, (_, i) => ({
		id: `method-${i}`,
		domain: "method",
		entryType: "rule",
		useWhen: "trigger ".repeat(150),
	}));
	const markdown = renderBundleMarkdown({ ...baseInput, governingIndex: rows });
	expect(new TextEncoder().encode(markdown).byteLength).toBeLessThanOrEqual(
		64 * 1024,
	);
	expect(markdown).not.toContain("method-99");
	expect(markdown).toContain("governingIndex");
	expect(markdown).toContain("node-ai-traces-read");
});
