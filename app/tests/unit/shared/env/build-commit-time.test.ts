// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `tests/unit/shared/env/build-commit-time`
 * Purpose: the image sets APP_BUILD_COMMIT_TIME to "" when CI passes no build arg; that must read as unset (the app boots), while a garbage value is refused.
 * Scope: the server env schema's one field.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";
import { serverSchema } from "@/shared/env/server-env";

const schema = serverSchema.pick({ APP_BUILD_COMMIT_TIME: true });

describe("APP_BUILD_COMMIT_TIME", () => {
  it("reads an empty string (the Dockerfile default) as unset, so the app still boots", () => {
    expect(schema.parse({ APP_BUILD_COMMIT_TIME: "" })).toEqual({ APP_BUILD_COMMIT_TIME: undefined });
    expect(schema.parse({})).toEqual({});
  });

  it("accepts epoch seconds and refuses anything else", () => {
    expect(schema.parse({ APP_BUILD_COMMIT_TIME: "1790000000" })).toEqual({ APP_BUILD_COMMIT_TIME: "1790000000" });
    for (const bad of ["garbage", "17900000x0", "123", " 1790000000", "1790000000.5"]) {
      expect(schema.safeParse({ APP_BUILD_COMMIT_TIME: bad }).success).toBe(false);
    }
  });
});
