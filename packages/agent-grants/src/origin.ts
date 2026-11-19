// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/origin`
 * Purpose: The one definition of a canonical https origin, shared by service assertions (an issuer) and orgs (an issuer-keyed org).
 * Scope: Pure.
 * Side-effects: none
 * @internal
 */

/** True for a canonical https origin: `https://host[:port]`, nothing else. */
export function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}
