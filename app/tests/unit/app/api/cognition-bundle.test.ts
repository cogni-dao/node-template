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
import { createHash } from "node:crypto";
import { FakeKnowledgeStoreAdapter } from "@cogni/knowledge-store/adapters/fake";
import {
	governingFixture,
	GOVERNING_FIXTURE_DOMAIN,
} from "../../../../../packages/knowledge-store/tests/fixtures/governing-index.js";
import {
	renderBundleMarkdown,
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
		expect(markdown).toContain(
			'{"reason":"<why, at most 25 words>","cites":[{"id":"<atom>"}],"set":{...}}',
		);
		expect(markdown).toContain(
			"GET https://poly.cognidao.org/api/v1/work/items?sortBy=rankScore&sortDirection=desc&limit=5",
		);
		for (const status of [
			"needs_triage",
			"needs_research",
			"needs_design",
			"needs_implement",
			"needs_closeout",
			"needs_merge",
			"done",
		])
			expect(markdown).toContain(`| ${status} |`);
	});

	it("leads the invariants with grounding in node knowledge", () => {
		expect(SESSION_BOOTSTRAP_INVARIANTS[0]).toMatch(/^GROUND EVERYTHING/);
		expect(SESSION_BOOTSTRAP_INVARIANTS[0]).toContain("node-template-architect");
		expect(SESSION_BOOTSTRAP_INVARIANTS[0]).toContain("knowledge refinement");
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

describe("no flat governing index in the Markdown (story.0044)", () => {
	it("routes by domains and the architect instead of listing governing rows", () => {
		const rows = Array.from({ length: 80 }, (_, i) => ({
			id: `build-compute-entry-${i}`,
			useWhen: `Build/compute runtime knowledge entry ${i}`,
			entryType: "guide",
			domain: "infrastructure",
		}));
		const md = renderBundleMarkdown({ ...baseInput, governingIndex: rows });
		expect(md).not.toContain("build-compute-entry-");
		expect(md).not.toContain("## Governing index");
		expect(md).toContain("## Knowledge domains");
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
			expect(markdown).toContain(`\`${id}\``);
		expect(markdown).toContain("GET https://cognidao.org/api/v1/knowledge/{id}");
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

it("follows the served oversized same-cognition index beyond 1,000 newer rows with exact trigger hashes and preserved mandatory bytes", async () => {
	const { rows, edges } = governingFixture();
	const store = new FakeKnowledgeStoreAdapter();
	await store.registerDomain({ id: GOVERNING_FIXTURE_DOMAIN, name: "Fixture" });
	await store.registerDomain({ id: "method", name: "Method" });
	vi.useFakeTimers();
	try {
		await store.withWrite(
			{ operationId: "governing-cognition", message: "fixture" },
			async (write) => {
				for (const row of rows) {
					vi.setSystemTime(row.createdAt);
					await write.addKnowledge(row);
				}
				for (const edge of edges) await write.addCitation(edge);
			},
		);
	} finally {
		vi.useRealTimers();
	}
	const digest = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const bodySnapshot = async () =>
		Promise.all(rows.map((r) => store.getKnowledge(r.id)));
	const before = digest(await bodySnapshot());
	const commits = store.commitLog.length;
	const orientationRow = await store.getKnowledge(
		"fresh-node-agent-orientation",
	);
	if (!orientationRow) throw new Error("Missing fixture orientation");
	const orientation = orientationRow.content;
	const goal = {
		id: "goal-local",
		title: "Approved local goal",
		content: "LOCAL GOAL BYTES",
		evaluateAt: null,
	};
	const expected = await store.listGoverningIndex();
	const list = vi.fn(() => store.listGoverningIndex());
	composition.port = {
		currentCommit: () => store.currentCommit(),
		listDomainsFull: () => store.listDomainsFull(),
		listGoverningIndex: list,
		getKnowledge: (id: string) => store.getKnowledge(id),
		listActiveGoals: async () => [goal],
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
		const request = async (url: string) => {
			const response = await handler(
				{ log: { info: vi.fn(), warn: vi.fn() } },
				new Request(url),
				{ id: "own-agent" },
			);
			expect(response.headers.get("cache-control")).toContain("private");
			return response.json();
		};
		const first = await request(
			"https://fresh-node.cognidao.org/api/v1/cognition",
		);
		// The Markdown lists no governing rows; the JSON keeps the complete array.
		expect(first.markdown).not.toContain("## Governing index");
		expect(first.markdown).not.toContain(
			"https://fresh-node.cognidao.org/api/v1/knowledge/index",
		);
		const followed = first;
		// Follow only the delivered complete array; the shared query has already selected membership.
		const selected = followed.governingIndex.filter(
			(r: { domain: string }) => r.domain === GOVERNING_FIXTURE_DOMAIN,
		);
		const expectedShelf = expected.filter(
			(r) => r.domain === GOVERNING_FIXTURE_DOMAIN,
		);
		expect(selected).toEqual(expectedShelf);
		expect(digest(selected)).toBe(digest(expectedShelf));
		expect(digest(followed.governingIndex)).toBe(digest(expected));
		expect(selected.some((r: { id: string }) => r.id === "gov-old-rule")).toBe(
			true,
		);
		expect(
			new Set(selected.map((r: { entryType: string }) => r.entryType)).size,
		).toBe(7);
		expect(
			selected.some((r: { id: string }) =>
				["gov-blank", "gov-null", "gov-retired", "gov-evidence"].includes(r.id),
			),
		).toBe(false);
		expect(first.skillsIndex).toHaveLength(expected.length);
		expect(first.skillsIndex[0]).toHaveProperty("title");
		for (const mandatory of [
			orientation,
			goal.content,
			"Node-owned mission",
			...SESSION_BOOTSTRAP_INVARIANTS,
		]) {
			for (const served of [first, followed]) {
				const start = served.markdown.indexOf(mandatory);
				expect(start).toBeGreaterThanOrEqual(0);
				expect(
					digest(served.markdown.slice(start, start + mandatory.length)),
				).toBe(digest(mandatory));
			}
		}
		expect(first.markdown).toContain("node-ai-traces-read");
		expect(first.markdown).toContain("agent-evaluation-loop");
		expect(first.markdown).toContain("langfuse-eval-expert");
		expect(digest(await bodySnapshot())).toBe(before);
		expect(store.commitLog).toHaveLength(commits);
		expect(JSON.stringify(first)).not.toContain("private-canonical-sentinel");
		expect(JSON.stringify(first)).not.toContain("private-legacy-sentinel");
		expect(fetcher).not.toHaveBeenCalled();
		const raw = (headers: HeadersInit = {}) =>
			handler(
				{ log: { info: vi.fn(), warn: vi.fn() } },
				new Request("https://fresh-node.cognidao.org/api/v1/cognition", {
					headers,
				}),
				{ id: "own-agent" },
			);
		const etag = (await raw()).headers.get("etag");
		expect(etag).toMatch(/^W\/"/);
		const revalidated = await raw({ "if-none-match": etag ?? "" });
		expect(revalidated.status).toBe(304);
		expect(revalidated.headers.get("server-timing")).toMatch(
			/^hub;dur=[\d.]+;desc="memo", total;dur=[\d.]+$/,
		);
		expect(await revalidated.text()).toBe("");
		// Every request at the same store revision is served from the memo.
		expect(list).toHaveBeenCalledTimes(1);
	} finally {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	}
});

it("serves mandatory local cognition intact, however large", async () => {
	const content = "MANDATORY ".repeat(8000);
	const markdown = renderBundleMarkdown({
		...baseInput,
		orientation: { id: "custom", content },
	});
	expect(markdown).toContain(content);
	expect(markdown).toContain("node-ai-traces-read");
});

it("serves a degraded bundle visibly with no ETag and no-store, and a hubless bundle the same", async () => {
	const { GET } = await import("@/app/api/v1/cognition/route");
	const handler = GET as unknown as (...args: unknown[]) => Promise<Response>;
	const call = () =>
		handler(
			{ log: { info: vi.fn(), warn: vi.fn() } },
			new Request("https://fresh-node.cognidao.org/api/v1/cognition", {
				headers: { "if-none-match": "*" },
			}),
			{ id: "own-agent" },
		);
	composition.port = {
		currentCommit: async () => "rev-degraded",
		listDomainsFull: async () => [],
		listGoverningIndex: async () => [],
		getKnowledge: async () => null,
		listActiveGoals: async () => {
			throw new Error("goals down");
		},
	};
	const degraded = await call();
	expect(degraded.status).toBe(200);
	expect(degraded.headers.get("etag")).toBeNull();
	expect(degraded.headers.get("cache-control")).toBe("no-store");
	expect((await degraded.json()).markdown).toContain("goals unavailable");

	composition.port = undefined;
	const hubless = await call();
	expect(hubless.status).toBe(200);
	expect(hubless.headers.get("etag")).toBeNull();
	expect((await hubless.json()).markdown).toContain(
		SESSION_BOOTSTRAP_INVARIANTS[0],
	);
});

describe("cognition route budgets and revalidation (bug.0018)", () => {
	const call = async (headers: HeadersInit = {}, user: unknown = { id: "agent" }) => {
		const { GET } = await import("@/app/api/v1/cognition/route");
		const handler = GET as unknown as (...args: unknown[]) => Promise<Response>;
		return handler(
			{ log: { info: vi.fn(), warn: vi.fn() } },
			new Request("https://fresh-node.cognidao.org/api/v1/cognition", {
				headers,
			}),
			user,
		);
	};
	const hub = (head: () => Promise<string>) => ({
		currentCommit: vi.fn(head),
		listDomainsFull: async () => [],
		listGoverningIndex: async () => [],
		getKnowledge: async () => null,
		listActiveGoals: async () => [],
	});

	it("answers 401 before touching the hub", async () => {
		const port = hub(async () => "rev-a");
		composition.port = port;
		const response = await call({}, null);
		expect(response.status).toBe(401);
		expect(port.currentCommit).not.toHaveBeenCalled();
	});

	it("never confirms a stale bundle with 304: 200, no ETag, no-store", async () => {
		let head: () => Promise<string> = async () => "rev-a";
		composition.port = hub(() => head());
		const first = await call();
		const etag = first.headers.get("etag");
		expect(etag).toMatch(/^W\//);
		head = async () => {
			throw new Error("dolt busy");
		};
		const stale = await call({ "if-none-match": etag ?? "" });
		expect(stale.status).toBe(200);
		expect(stale.headers.get("etag")).toBeNull();
		expect(stale.headers.get("cache-control")).toBe("no-store");
		expect(stale.headers.get("server-timing")).toContain(
			'desc="stale head_failed"',
		);
	});

	it("answers a retryable 503 when nothing complete can be read", async () => {
		composition.port = hub(async () => {
			throw new Error("dolt down");
		});
		const response = await call();
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(await response.json()).toEqual({
			error: "cognition_unavailable",
			retryable: true,
		});
	});
});

