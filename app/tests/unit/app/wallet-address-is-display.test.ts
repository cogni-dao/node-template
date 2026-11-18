// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/wallet-address-is-display`
 * Purpose: WALLET_ADDRESS_IS_DISPLAY (ONE_WALLET_ONE_KEY). `users.wallet_address` keeps the form the wallet signed in with, so no authority or payout
 *   path may read it: only normalized `user_bindings` wallet rows decide. A source scan over the app and every package fails on a new read; the
 *   allowlist names each file that may touch the column and why that use is display, login or deny-only.
 * Scope: Reads source files only; renders nothing.
 * Invariants: a stale allowlist entry fails; the list may only shrink or gain an entry that explains why it never ALLOWS anything.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const ROOTS = [join(ROOT, "app/src"), ...readdirSync(join(ROOT, "packages")).map((pkg) => join(ROOT, "packages", pkg, "src"))];
const SKIP = /(^|\/)(migrations|node_modules|dist)\//;
/** The schema definition itself. */
const DEFINITION = ["packages/db-schema/src/refs.ts", "packages/db-schema/src/auth.ts"];

/** Files that read `users.wallet_address` today. Each use is display, login or deny-only; none may ALLOW a payout or an authority. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  "app/src/auth.ts": "login: legacy fallback when no wallet binding exists (compared with lower()) and the session's display wallet",
  "app/src/app/_facades/users/profile.server.ts": "profile display name and truncated address",
  "app/src/adapters/server/metrics/runs.source.ts": "run-count metric class (human vs agent); it grants and pays nothing",
  "packages/agent-grants/src/credentials/postgres.ts": "deny-only: a SIWE human cannot upgrade into an agent key (refusal, never an allow)",
  "packages/db-client/src/adapters/drizzle-claimant-wallet-resolver.adapter.ts": "deny-only defense in depth: an agent's display wallet is never a payee",
};

const READS_COLUMN = /\busers\.walletAddress\b|\bwallet_address\b|columns:\s*\{\s*walletAddress/;
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

function sourceFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });
  } catch {
    return [];
  }
}

const readers = ROOTS.flatMap(sourceFiles)
  .map((file) => ({ rel: relative(ROOT, file), text: code(readFileSync(file, "utf8")) }))
  .filter((f) => !SKIP.test(f.rel) && !DEFINITION.includes(f.rel) && READS_COLUMN.test(f.text))
  .map((f) => f.rel);

describe("WALLET_ADDRESS_IS_DISPLAY", () => {
  it("no new file reads users.wallet_address: a display-form address must never decide a payee or an admin (defect: a casing split makes one wallet two owners)", () => {
    expect(readers.filter((rel) => !(rel in ALLOWLIST))).toEqual([]);
  });

  it("the allowlist has no stale entry, so it cannot hide a future read", () => {
    expect(Object.keys(ALLOWLIST).filter((rel) => !readers.includes(rel))).toEqual([]);
  });
});
