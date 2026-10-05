// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/knowledge-base-seeds`
 * Purpose: Guard the universal, node-neutral knowledge bootstrap.
 * Scope: Static seed values only; no database writes or network calls.
 * Invariants: UNIVERSAL_DOMAINS_ONLY, SOVEREIGN_ORIENTATION_HANDOFF, SHARED_AGENT_CONTRACT.
 * Side-effects: none
 * @public
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_KNOWLEDGE_SEEDS } from "../../../packages/knowledge-base/src/seeds/base";
import { BASE_DOMAIN_SEEDS } from "../../../packages/knowledge-base/src/seeds/domains";

describe("knowledge base seeds", () => {
	it("ships only the universal domain baseline", () => {
		const domainIds = BASE_DOMAIN_SEEDS.map(({ id }) => id);
		expect(domainIds).toEqual(["meta", "mission", "strategy"]);
		expect(domainIds).not.toEqual(
			expect.arrayContaining([
				"prediction-market",
				"infrastructure",
				"governance",
				"reservations",
			]),
		);
		expect(
			BASE_KNOWLEDGE_SEEDS.every(({ domain }) => domainIds.includes(domain)),
		).toBe(true);
	});

	it("hands the generic starter to one sovereign node", () => {
		const orientation = BASE_KNOWLEDGE_SEEDS.find(
			({ id }) => id === "cogni-agent-orientation",
		);
		expect(orientation?.domain).toBe("meta");
		expect(orientation?.entryType).toBe("guide");
		expect(orientation?.content).toContain(
			"Align once with this node's human CEO",
		);
		expect(orientation?.content).toContain(
			"Persist the CEO-approved strings byte-for-byte",
		);
		expect(orientation?.content).toContain("`<slug>-agent-orientation`");
		expect(orientation?.content).toContain("this node's own Dolt hub");
		expect(orientation?.content).toContain(
			"Never copy another node's mission or node-specific contract",
		);
	});

	it("preserves the shared process and status contracts", () => {
		const content = BASE_KNOWLEDGE_SEEDS.find(
			({ id }) => id === "cogni-agent-orientation",
		)?.content;
		expect(content).toContain(
			'<agent-contract rule="How you work plus how you communicate.',
		);
		expect(content).toContain("<process-contract rule=");
		expect(content).toContain("<status-contract rule=");
		expect(content).toContain("| 🎯 **Goal** |");
		expect(content).toContain("| **Done when** |");
		expect(content).toContain("| **Followed** |");
		expect(content).toContain("Only three legal stop states");
		expect(content).toContain("</agent-contract>");

		const terminal =
			"| technical anything | never | research → compare → record → act |";
		const start = content?.indexOf("## The agent-contract") ?? -1;
		const terminalStart = content?.indexOf(terminal) ?? -1;
		expect(start).toBeGreaterThanOrEqual(0);
		expect(terminalStart).toBeGreaterThan(start);
		const sharedContract = `${content?.slice(
			start,
			terminalStart + terminal.length,
		)}\n`;
		expect(createHash("sha256").update(sharedContract).digest("hex")).toBe(
			"5b31d2166c819002120bb1c3b88ab1c9fd299510c5a160b1bf7fa3a20a91a914",
		);
	});
});
