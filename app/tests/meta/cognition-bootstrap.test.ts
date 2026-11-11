// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/cognition-bootstrap`
 * Purpose: Guard the uncapped, single-presenter SessionStart contract (story.5070).
 * Scope: Repo config plus hermetic loader/legacy-installer subprocesses.
 * Invariants: NATIVE_HARNESS_CHANNELS, NO_CODEX_SPILL, INSTALLER_RECONCILES.
 * Side-effects: Temporary files under the OS temp directory only.
 * Links: .codex/config.toml, scripts/agent/session-cognition.sh
 * @public
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const LOADER = path.join(REPO_ROOT, "scripts/agent/session-cognition.sh");
const INSTALLER = path.join(
	REPO_ROOT,
	"scripts/agent/install-codex-cognition-hook.sh",
);
const CONDUCTOR_SETUP = path.join(
	REPO_ROOT,
	"scripts/conductor-worktree-setup.sh",
);
// The former hard cap (bug.5284), kept only to size an over-cap bundle that must
// now surface WHOLE rather than be rejected (story.5070).
const FORMER_CAP_BYTES = 16 * 1024;
const CACHE_PATH = ".cogni/.cognition-cache.md";
const fixtures: string[] = [];

function fixture(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "cogni-bootstrap-"));
	fixtures.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of fixtures.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("session cognition hook", () => {
	it("never ships or trusts a git-tracked cognition snapshot", () => {
		const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
		expect(gitignore).toContain(CACHE_PATH);
		const tracked = execFileSync("git", ["ls-files", "--", CACHE_PATH], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		}).trim();
		if (tracked) {
			const pendingDeletion = execFileSync(
				"git",
				["diff", "--name-only", "--diff-filter=D", "--", CACHE_PATH],
				{ cwd: REPO_ROOT, encoding: "utf8" },
			).trim();
			expect(pendingDeletion).toBe(CACHE_PATH);
		}

		const root = fixture();
		const cache = path.join(root, CACHE_PATH);
		mkdirSync(path.dirname(cache), { recursive: true });
		writeFileSync(cache, "stale committed cognition\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["add", CACHE_PATH], { cwd: root });

		const bin = path.join(root, "bin");
		const curl = path.join(bin, "curl");
		mkdirSync(bin);
		writeFileSync(
			curl,
			"#!/bin/sh\nprintf '%s\\n' '{\"markdown\":\"live cognition\"}'\n",
		);
		chmodSync(curl, 0o755);

		const output = execFileSync("bash", [LOADER], {
			cwd: root,
			env: {
				...process.env,
				CODEX_HOME: path.join(root, "no-user-hook"),
				CODEX_THREAD_ID: "",
				COGNI_NODE_API_KEY: "test-key",
				PATH: `${bin}:${process.env.PATH ?? ""}`,
			},
			encoding: "utf8",
		});

		// First boot: this session's CLAUDE.md import ran before the file existed,
		// so Claude gets the fetched bundle through its uncapped structured
		// channel, never a raw-stdout preview (bug.0018).
		expect(JSON.parse(output)).toEqual({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: "live cognition",
			},
		});
		expect(readFileSync(cache, "utf8")).toBe("live cognition\n");
	});

	it("uses one native, uncapped channel per supported harness (story.5070)", () => {
		const config = readFileSync(
			path.join(REPO_ROOT, ".codex/config.toml"),
			"utf8",
		);
		const claude = readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
		const opencode = JSON.parse(
			readFileSync(path.join(REPO_ROOT, "opencode.json"), "utf8"),
		) as { instructions?: string[] };
		const loader = readFileSync(LOADER, "utf8");

		expect(config).toContain("additionalContextLimit = 0");
		expect(config).toContain("git rev-parse --show-toplevel");
		expect(claude).toContain("@AGENTS.md");
		expect(claude).toContain("@.cogni/.cognition-cache.md");
		expect(opencode.instructions).toContain(CACHE_PATH);
		// No producer-side byte ceiling survives on either channel.
		expect(loader).not.toContain("SESSION_COGNITION_MAX_BYTES");
		expect(loader).not.toContain("bundle_fits_budget");
		expect(loader).not.toContain("oversized_bundle_notice");
		// Codex consumes raw stdout; Claude gets the structured channel only on a
		// boot whose import could have missed the cache (bug.0018).
		expect(loader).toContain("emit_agent_context");
		expect(loader).toContain("hookSpecificOutput");
		expect(loader).toContain("cache_is_fresh_for_this_boot");
	});

	it("installs the stable user presenter during local Conductor setup", () => {
		const setup = readFileSync(CONDUCTOR_SETUP, "utf8");
		const guardedInstall = [
			`if [[ "\${CONDUCTOR_IS_LOCAL:-1}" == "1" ]]; then`,
			"  bash scripts/agent/install-codex-cognition-hook.sh",
			"fi",
		].join("\n");
		expect(setup).toContain(guardedInstall);
		expect(setup.indexOf(guardedInstall)).toBeLessThan(
			setup.indexOf("pnpm install --offline --frozen-lockfile"),
		);
	});

	it("warms the cognition cache in workspace setup before anything slow (bug.0018)", () => {
		const setup = readFileSync(CONDUCTOR_SETUP, "utf8");
		// Claude Code resolves the CLAUDE.md @import before its SessionStart hook
		// can write the cache, so setup must warm it before the first agent starts.
		const linkKey = setup.indexOf('\nlink_from_auth_root ".env.cogni"');
		const warm = setup.indexOf("\nwarm_cognition_cache\n");
		expect(linkKey).toBeGreaterThan(-1);
		expect(warm).toBeGreaterThan(linkKey);
		for (const slow of [
			"\nrefresh_workspace_base_ref\n",
			"pnpm install --offline --frozen-lockfile",
			"pnpm build:packages",
		])
			expect(warm).toBeLessThan(setup.indexOf(slow));
		expect(setup).toContain("bash scripts/agent/session-cognition.sh");
	});

	it("keeps the agent bootstrap automatic", () => {
		const agents = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

		expect(agents).not.toContain("pnpm codex:cognition:install");
		expect(agents).toContain("model-visible before normal work");
	});

	it("presents only to Codex while Claude reads the complete cache import (story.5070)", () => {
		const root = fixture();
		const noUserHook = path.join(root, "no-user-hook");
		const env = {
			...process.env,
			CODEX_HOME: noUserHook,
			CODEX_THREAD_ID: "",
		};

		const small = path.join(root, "small");
		mkdirSync(path.join(small, ".cogni"), { recursive: true });
		writeFileSync(
			path.join(small, ".cogni/.cognition-cache.md"),
			"complete cognition\n",
		);
		// A warm cache older than this boot: the import already has it.
		const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(
			path.join(small, ".cogni/.cognition-cache.md"),
			anHourAgo,
			anHourAgo,
		);
		// Claude Code path: write-only hook; CLAUDE.md owns presentation.
		const smallOut = execFileSync("bash", [LOADER], {
			cwd: small,
			env,
			encoding: "utf8",
		});
		expect(smallOut).toBe("");

		// Codex path: raw stdout verbatim (its spill is disabled in config).
		expect(
			execFileSync("bash", [LOADER], {
				cwd: small,
				env: { ...env, CODEX_THREAD_ID: "codex-raw", TMPDIR: root },
				encoding: "utf8",
			}),
		).toBe("complete cognition\n");

		mkdirSync(path.join(root, "cogni-cognition-lock-test.lock"));
		expect(
			execFileSync("bash", [LOADER], {
				cwd: small,
				env: {
					...env,
					CODEX_THREAD_ID: "lock-test",
					TMPDIR: root,
				},
				encoding: "utf8",
			}),
		).toBe("");

		// story.5070 regression: a bundle past the former 16 KB cap remains whole
		// in the cache Claude imports; the write-only hook never emits a preview.
		const overCapBytes = FORMER_CAP_BYTES + 1000;
		const large = path.join(root, "large");
		mkdirSync(path.join(large, ".cogni"), { recursive: true });
		writeFileSync(
			path.join(large, ".cogni/.cognition-cache.md"),
			"x".repeat(overCapBytes),
		);
		utimesSync(
			path.join(large, ".cogni/.cognition-cache.md"),
			anHourAgo,
			anHourAgo,
		);
		const largeOut = execFileSync("bash", [LOADER], {
			cwd: large,
			env,
			encoding: "utf8",
		});
		expect(largeOut).toBe("");
		expect(readFileSync(path.join(large, CACHE_PATH), "utf8")).toHaveLength(
			overCapBytes,
		);
		expect(largeOut).not.toContain("bundle rejected before injection");

		// A cache written moments ago (workspace setup racing this boot) may have
		// missed the import: Claude gets it whole through the structured channel.
		const fresh = path.join(root, "fresh");
		mkdirSync(path.join(fresh, ".cogni"), { recursive: true });
		writeFileSync(path.join(fresh, CACHE_PATH), "x".repeat(overCapBytes));
		const freshOut = execFileSync("bash", [LOADER], {
			cwd: fresh,
			env,
			encoding: "utf8",
		});
		expect(
			JSON.parse(freshOut).hookSpecificOutput.additionalContext,
		).toHaveLength(overCapBytes);

		// Resume, clear and compact keep the import's copy: no duplicate.
		for (const source of ["resume", "clear", "compact"]) {
			expect(
				execFileSync("bash", [LOADER], {
					cwd: fresh,
					env,
					encoding: "utf8",
					input: JSON.stringify({ hook_event_name: "SessionStart", source }),
				}),
			).toBe("");
		}
		expect(
			JSON.parse(
				execFileSync("bash", [LOADER], {
					cwd: fresh,
					env,
					encoding: "utf8",
					input: JSON.stringify({
						hook_event_name: "SessionStart",
						source: "startup",
					}),
				}),
			).hookSpecificOutput.additionalContext,
		).toHaveLength(overCapBytes);

		// A first boot that cannot load tells Claude why, through the same channel.
		const keyless = path.join(root, "keyless");
		const offline = path.join(keyless, "bin");
		mkdirSync(offline, { recursive: true });
		// Hermetic: the fetch fails at once instead of reaching a real hub.
		writeFileSync(path.join(offline, "curl"), "#!/bin/sh\nexit 22\n");
		chmodSync(path.join(offline, "curl"), 0o755);
		const keylessOut = execFileSync("bash", [LOADER], {
			cwd: keyless,
			env: {
				...env,
				COGNI_NODE_API_KEY: "",
				PATH: `${offline}:${process.env.PATH ?? ""}`,
			},
			encoding: "utf8",
		});
		expect(
			JSON.parse(keylessOut).hookSpecificOutput.additionalContext,
		).toContain("no node credentials yet");
	});

	it("reconciles the legacy user hook idempotently", () => {
		const codexHome = fixture();
		const hookPath = path.join(codexHome, "hooks/cogni-session-cognition.sh");
		writeFileSync(
			path.join(codexHome, "config.toml"),
			[
				'model = "gpt-5.5"',
				"",
				"[[hooks.SessionStart]]",
				'matcher = "startup|resume"',
				"",
				"[[hooks.SessionStart.hooks]]",
				'type = "command"',
				'command = "echo keep-me"',
				"",
				"[[hooks.SessionStart.hooks]]",
				'type = "command"',
				`command = "bash ${hookPath}"`,
				'statusMessage = "Loading Cogni cognition substrate"',
			].join("\n"),
		);

		const env = { ...process.env, CODEX_HOME: codexHome };
		execFileSync("bash", [INSTALLER], { env });
		execFileSync("bash", [INSTALLER], { env });
		const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
		const installedHook = readFileSync(hookPath, "utf8");

		expect(config.match(/cogni-session-cognition\.sh/g)).toHaveLength(1);
		expect(config).toContain('command = "echo keep-me"');
		expect(config).toContain('matcher = "startup|resume|clear|compact"');
		expect(config).toContain("additionalContextLimit = 0");
		expect(installedHook).toContain("cache_is_repo_tracked");
		expect(installedHook).toContain(
			'if [[ -s "$CACHE_FILE" ]] && ! cache_is_repo_tracked; then',
		);
		execFileSync("bash", ["-n", hookPath]);

		const repo = fixture();
		const cache = path.join(repo, CACHE_PATH);
		mkdirSync(path.dirname(cache), { recursive: true });
		writeFileSync(
			path.join(repo, ".cogni/repo-spec.yaml"),
			"intent:\n  name: node-template\n",
		);
		writeFileSync(cache, "stale committed cognition\n");
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["add", CACHE_PATH], { cwd: repo });

		const bin = path.join(repo, "bin");
		const curl = path.join(bin, "curl");
		mkdirSync(bin);
		writeFileSync(
			curl,
			"#!/bin/sh\nprintf '%s\\n' '{\"markdown\":\"live cognition\"}'\n",
		);
		chmodSync(curl, 0o755);

		const output = execFileSync("bash", [hookPath], {
			cwd: repo,
			env: {
				...process.env,
				CODEX_HOME: codexHome,
				CODEX_THREAD_ID: "",
				COGNI_NODE_API_KEY: "test-key",
				PATH: `${bin}:${process.env.PATH ?? ""}`,
			},
			encoding: "utf8",
		});
		expect(output).toBe("live cognition\n");
		expect(readFileSync(cache, "utf8")).toBe("live cognition\n");
	});
});
