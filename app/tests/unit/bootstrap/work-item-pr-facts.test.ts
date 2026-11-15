// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `tests/unit/bootstrap/work-item-pr-facts`
 * Purpose: The status gates' PR read adapts the unauthenticated GitHub read to the work-items port (task.0122).
 * Scope: Fake VcsCapability only; no network.
 * Invariants: head and merged come from `getPr`; an unparseable URL, an unreadable head or a failed read throws.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
	createPrFactsPort,
	resolveWorkItemsPrRepos,
} from "@/bootstrap/capabilities/work-item-pr-facts";

const SIGNAL = AbortSignal.timeout(1_000);
const HEAD = "ABCDEF0123456789abcdef0123456789ABCDEF01";

describe("resolveWorkItemsPrRepos", () => {
	it("pins one well-formed owner/repo, trimmed", () => {
		expect(resolveWorkItemsPrRepos("cogni-dao/node-template")).toEqual({
			repos: ["cogni-dao/node-template"],
			ignored: [],
		});
		expect(resolveWorkItemsPrRepos("  Cogni-DAO/levelup.app ")).toEqual({
			repos: ["Cogni-DAO/levelup.app"],
			ignored: [],
		});
	});

	it("pins several comma-separated repositories and reports the entries it ignored", () => {
		expect(
			resolveWorkItemsPrRepos("cogni-dao/node-template, cogni-dao/levelup,,"),
		).toEqual({
			repos: ["cogni-dao/node-template", "cogni-dao/levelup"],
			ignored: [],
		});
		expect(resolveWorkItemsPrRepos("cogni-dao/node-template,oops,a/b/c")).toEqual({
			repos: ["cogni-dao/node-template"],
			ignored: ["oops", "a/b/c"],
		});
	});

	it.each([
		[undefined, "unset", []],
		["", "unset", []],
		["   ", "unset", []],
		[" , ", "unset", []],
		["node-template", "invalid", ["node-template"]],
		["a/b/c", "invalid", ["a/b/c"]],
		["https://github.com/a/b", "invalid", ["https://github.com/a/b"]],
	])("%j leaves the repositories unpinned (%s), never defaulted, never a boot failure", (value, reason, ignored) => {
		expect(resolveWorkItemsPrRepos(value as string | undefined)).toEqual({
			repos: [],
			ignored,
			reason,
		});
	});
});

describe("createPrFactsPort", () => {
	it("reads owner, repo and number from the URL and returns the lowercase head and merge state", async () => {
		const getPr = vi.fn(async () => ({ headSha: HEAD, merged: true, state: "closed" }));
		const port = createPrFactsPort({ getPr } as never);
		const facts = await port.read(
			"https://github.com/cogni-dao/node-template/pull/377",
			SIGNAL,
		);
		// The adapter's 5 s signal reaches the fetch.
		expect(getPr).toHaveBeenCalledWith({
			owner: "cogni-dao",
			repo: "node-template",
			prNumber: 377,
			signal: SIGNAL,
		});
		expect(facts).toEqual({ head: HEAD.toLowerCase(), merged: true, open: false });
	});

	it("maps the PR state to the open flag: open is open, closed without merging is not", async () => {
		const read = (state: "open" | "closed", merged: boolean) =>
			createPrFactsPort({
				getPr: async () => ({ headSha: HEAD, merged, state }),
			} as never).read("https://github.com/cogni-dao/node-template/pull/1", SIGNAL);
		expect(await read("open", false)).toMatchObject({ merged: false, open: true });
		expect(await read("closed", false)).toMatchObject({ merged: false, open: false });
	});

	it.each([
		["not a pull request URL", "https://github.com/cogni-dao/node-template/issues/3"],
		["an inbox URL", "https://node.example/knowledge/inbox/contrib-x"],
	])("throws for %s", async (_label, url) => {
		const port = createPrFactsPort({ getPr: vi.fn() } as never);
		await expect(port.read(url, SIGNAL)).rejects.toThrow();
	});

	it("throws on an unreadable head and on a failed read", async () => {
		const bad = createPrFactsPort({
			getPr: async () => ({ headSha: "short", merged: false }),
		} as never);
		await expect(
			bad.read("https://github.com/cogni-dao/node-template/pull/1", SIGNAL),
		).rejects.toThrow("unreadable PR head");
		const down = createPrFactsPort({
			getPr: async () => {
				throw new Error("GitHub API 403");
			},
		} as never);
		await expect(
			down.read("https://github.com/cogni-dao/node-template/pull/1", SIGNAL),
		).rejects.toThrow("403");
	});
});
