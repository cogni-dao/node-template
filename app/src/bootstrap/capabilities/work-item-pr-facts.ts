// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item-pr-facts`
 * Purpose: The work-items `PrFactsPort` (task.0122): a PR's current head and merge state for the code gates, read through the node's existing unauthenticated GitHub read.
 * Scope: Adapts `VcsCapability.getPr` to the port. The 5 s timeout and the 60 s cache per PR URL belong to the work-items adapter, not to this wiring.
 * Invariants:
 *   - NO_NEW_SECRETS: the node holds no GitHub credential; the read is the public one (`createGithubReadVcsCapability`).
 *   - FAILURE_THROWS: any non-2xx, an unparseable URL or an unreadable head throws; the gate answers 503 and writes nothing.
 * Side-effects: IO (one GitHub REST read per call)
 * Links: hub work-cicd-gates-design (One gate predicate), ./vcs.ts
 * @internal
 */

import type { VcsCapability } from "@cogni/ai-tools";
import {
	parsePullRequestUrl,
	type PrFactsPort,
	resolvePrRepoPin,
} from "@cogni/work-items";

/** `WORK_ITEMS_PR_REPO` as the gate takes it; the one reader lives with the gate predicate in `@cogni/work-items`. */
export const resolveWorkItemsPrRepos = resolvePrRepoPin;

export function createPrFactsPort(
	vcs: Pick<VcsCapability, "getPr">,
): PrFactsPort {
	return {
		async read(url, signal) {
			const parsed = parsePullRequestUrl(url);
			if (!parsed) throw new Error("not a GitHub pull request URL");
			const pr = await vcs.getPr({
				owner: parsed.owner,
				repo: parsed.repo,
				prNumber: parsed.number,
				signal,
			});
			const head = pr.headSha.toLowerCase();
			if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("unreadable PR head");
			return { head, merged: pr.merged, open: pr.state === "open" };
		},
	};
}
