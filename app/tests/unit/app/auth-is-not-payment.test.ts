// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/auth-is-not-payment`
 * Purpose: AUTH_IS_NOT_PAYMENT, as an architecture check. No claimant or payout path reads a sign-in wallet (a `wallet` binding or `users.wallet_address`) or the
 *   principal's kind (`agent_principals`): where a principal is paid comes from `payout_addresses` / `payout_beneficiaries` and nothing else. A future change that
 *   reads a login wallet to pay someone, or skips a payee by kind, fails here before it can ship.
 * Scope: Source scan of the payout path: the claimant resolver, the payout config facade and routes, the shared payout helper, the settlement append, reconcile/finalize and the Merkle distribution code.
 *   GitHub identity reads (`user_bindings` provider github) stay: they say who a claimant key is, never where they are paid.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = resolve(__dirname, "../../../../packages");
const APP_SRC = resolve(__dirname, "../../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const PAYOUT_PATH = [
  join(PACKAGES, "db-client/src/adapters/drizzle-claimant-wallet-resolver.adapter.ts"),
  join(PACKAGES, "db-client/src/adapters/payout-address.ts"),
  join(PACKAGES, "db-client/src/adapters/drizzle-attribution.adapter.ts"),
  ...sourceFiles(join(PACKAGES, "aragon-osx/src")),
  ...sourceFiles(join(PACKAGES, "attribution-pipeline-plugins/src/settlement")),
  ...sourceFiles(join(PACKAGES, "attribution-pipeline-plugins/src/finalize")),
  // The payout config writes: the facade and every route that sets an address or a beneficiary.
  join(APP_SRC, "app/_facades/identity/payout.server.ts"),
  ...sourceFiles(join(APP_SRC, "app/api/v1/identity/payout-address")),
  ...sourceFiles(join(APP_SRC, "app/api/v1/identity/beneficiary")),
];

/** Code only: block and line comments removed, so a doc line that names the rule is not a read. */
const code = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("AUTH_IS_NOT_PAYMENT: the payout path never reads a sign-in wallet or the principal's kind", () => {
  it("scans the files it is meant to guard (a broken scanner must not pass silently)", () => {
    expect(PAYOUT_PATH.length).toBeGreaterThan(12);
    expect(code(join(PACKAGES, "db-client/src/adapters/payout-address.ts"))).toContain("payoutBeneficiaries");
  });

  it.each(PAYOUT_PATH.map((file) => [file.replace(/^.*\/(packages|app)\//, "$1/"), file]))("%s reads no wallet binding, users.wallet_address or agent_principals", (_name, file) => {
    const src = code(file as string);
    expect(src).not.toMatch(/["']wallet["']/);
    expect(src).not.toMatch(/walletAddress|wallet_address/);
    expect(src).not.toMatch(/agentPrincipals|agent_principals/);
  });
});
