// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `.opencode/plugins/cogni-cognition`
 * Purpose: Produce this node's cognition cache before OpenCode resolves the
 *   `opencode.json` instructions that import it, so a cold worktree boots with
 *   the complete agent-contract instead of the bootstrap floor alone.
 * Scope: OpenCode 1.x startup only. Invokes the shared loader; never authors or
 *   re-formats cognition, and never becomes a second delivery authority.
 * Invariants: NATIVE_BEFORE_FIRST_TOKEN, ONE_LOADER, NEVER_FATAL.
 * Side-effects: Runs `scripts/agent/session-cognition.sh`, which may write
 *   `.cogni/.cognition-cache.md` (gitignored) and refresh it in the background.
 * Links: opencode.json, scripts/agent/session-cognition.sh, AGENTS.md
 * @public
 */

import { existsSync } from "node:fs";
import path from "node:path";

const CACHE_FILE = path.join(".cogni", ".cognition-cache.md");

/**
 * OpenCode loads project plugins during instance startup, before it assembles
 * the system prompt from `instructions`. That ordering is the whole point: it is
 * the OpenCode analogue of Claude Code's SessionStart hook and Codex's
 * SessionStart hook, and it is the only place a producer can run early enough
 * for the very first model token.
 *
 * Presenting the cache is not this plugin's job. `opencode.json` already imports
 * `.cogni/.cognition-cache.md`; this only guarantees the file exists by then.
 */
export const CogniCognition = async ({ directory, worktree, $, client }) => {
	const root = worktree || directory;
	if (!root) return {};

	const loader = path.join(root, "scripts/agent/session-cognition.sh");
	const spec = path.join(root, ".cogni/repo-spec.yaml");
	// Only a Cogni node repository has both. Anywhere else this plugin is inert.
	if (!existsSync(loader) || !existsSync(spec)) return {};

	try {
		// The loader is local-first: a warm cache presents offline and only
		// schedules a TTL-gated background refresh, so steady-state boot cost is
		// one bash spawn. Only a genuine first boot touches the network, already
		// bounded by the loader's own fetch timeout.
		await $`bash ${loader}`.cwd(root).quiet().nothrow();
	} catch {
		// Acquisition failure must never block startup. Fall through to the
		// check below rather than throwing.
	}

	// Never fail silently. The loader's own first-boot notice is written to
	// stdout for Codex only, so an OpenCode session that still has no cache is
	// exactly the invisible degradation this producer exists to remove.
	if (!existsSync(path.join(root, CACHE_FILE))) {
		try {
			await client?.app?.log({
				body: {
					service: "cogni-cognition",
					level: "warn",
					message:
						"Cognition cache still absent after the shared loader ran: this session boots with the AGENTS.md floor and no agent-contract. Diagnose credentials or hub reachability before normal work.",
					extra: { root },
				},
			});
		} catch {
			// Logging is best-effort; startup is never blocked by it.
		}
	}

	return {};
};
