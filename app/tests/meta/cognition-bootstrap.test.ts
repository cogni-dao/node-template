// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/cognition-bootstrap`
 * Purpose: Guard the uncapped, single-presenter SessionStart contract (story.5070).
 * Scope: Repo config plus hermetic loader/legacy-installer subprocesses.
 * Invariants: NO_CODEX_SPILL, UNCAPPED_BOTH_CHANNELS, INSTALLER_RECONCILES.
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

// The text the agent actually receives, regardless of which channel the loader
// used: Claude Code structured JSON (hookSpecificOutput.additionalContext) or
// Codex raw stdout. Lets a content assertion stay channel-agnostic.
function surfaced(hookStdout: string): string {
	try {
		const parsed = JSON.parse(hookStdout);
		const ctx = parsed?.hookSpecificOutput?.additionalContext;
		if (typeof ctx === "string") return ctx;
	} catch {
		// Not JSON ⇒ raw stdout channel (Codex).
	}
	return hookStdout;
}

// True iff the loader used the Claude Code structured additionalContext channel.
function usedAdditionalContextChannel(hookStdout: string): boolean {
	try {
		const parsed = JSON.parse(hookStdout);
		return typeof parsed?.hookSpecificOutput?.additionalContext === "string";
	} catch {
		return false;
	}
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

		// CODEX_THREAD_ID="" ⇒ Claude Code path ⇒ structured JSON channel.
		expect(usedAdditionalContextChannel(output)).toBe(true);
		expect(surfaced(output)).toBe("live cognition");
		expect(readFileSync(cache, "utf8")).toBe("live cognition\n");
	});

	it("disables Codex's spill and caps neither delivery channel (story.5070)", () => {
		const config = readFileSync(
			path.join(REPO_ROOT, ".codex/config.toml"),
			"utf8",
		);
		const loader = readFileSync(LOADER, "utf8");

		expect(config).toContain("additionalContextLimit = 0");
		expect(config).toContain("git rev-parse --show-toplevel");
		// No producer-side byte ceiling survives on either channel.
		expect(loader).not.toContain("SESSION_COGNITION_MAX_BYTES");
		expect(loader).not.toContain("bundle_fits_budget");
		expect(loader).not.toContain("oversized_bundle_notice");
		// The loader routes through the channel-aware emitter.
		expect(loader).toContain("emit_agent_context");
		expect(loader).toContain("hookSpecificOutput");
		expect(loader).toContain("additionalContext");
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

	it("documents the node-owned Conductor bootstrap without a monorepo auth root", () => {
		const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
		const agents = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

		expect(readme).toContain("COGNI_NODE_AUTH_ROOT");
		expect(readme).not.toContain("COGNI_TEMPLATE_ROOT");
		expect(readme).toContain("stable user-level\nCodex cognition presenter");
		expect(agents).toContain("pnpm codex:cognition:install");
	});

	it("surfaces a cache verbatim on both channels and never rejects an oversized one (story.5070)", () => {
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
		// Claude Code path: surfaced verbatim through the structured channel.
		const smallOut = execFileSync("bash", [LOADER], {
			cwd: small,
			env,
			encoding: "utf8",
		});
		expect(usedAdditionalContextChannel(smallOut)).toBe(true);
		expect(surfaced(smallOut)).toBe("complete cognition");

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

		// story.5070 regression: a bundle past the former 16 KB cap must surface
		// WHOLE through the Claude Code structured channel — never truncated or
		// rejected. This is the assertion the original bug.5284 ceiling got backwards.
		const overCapBytes = FORMER_CAP_BYTES + 1000;
		const large = path.join(root, "large");
		mkdirSync(path.join(large, ".cogni"), { recursive: true });
		writeFileSync(
			path.join(large, ".cogni/.cognition-cache.md"),
			"x".repeat(overCapBytes),
		);
		const largeOut = execFileSync("bash", [LOADER], {
			cwd: large,
			env,
			encoding: "utf8",
		});
		expect(usedAdditionalContextChannel(largeOut)).toBe(true);
		expect(surfaced(largeOut)).toHaveLength(overCapBytes);
		expect(largeOut).not.toContain("bundle rejected before injection");
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
