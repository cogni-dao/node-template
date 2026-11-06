// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/identity-client/vitest.config`
 * Purpose: Run identity client public API tests.
 * Scope: Package-local tests.
 * Invariants: Tests do not depend on app code or network.
 * Side-effects: none
 * Links: tests/
 * @internal
 */
import { defineProject } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: required by vitest
export default defineProject({
  test: {
    name: "identity-client",
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
