// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/work.items.spec-refs.contract`
 * Purpose: Pins that create and PATCH both take a written `specRefs` entry only as `knowledge:<atom-id>` (story.0069).
 * Scope: Pure Zod schema validation of the node's wire operations. Does not test storage.
 * Invariants:
 *   - ONE_SPEC_REF_TYPE: create and PATCH share `SpecRefsInputSchema`; both refuse a URL and a bare id with one message.
 * Side-effects: none
 * Links: packages/work-items/src/spec-refs.ts, hub work-item-design-links
 * @internal
 */

import {
  workItemsCreateOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { SPEC_REF_MESSAGE } from "@cogni/work-items";
import { describe, expect, it } from "vitest";

const create = (specRefs: unknown) =>
  workItemsCreateOperation.input.safeParse({ type: "task", title: "t", specRefs });
const patch = (specRefs: unknown) =>
  workItemsPatchOperation.input.safeParse({ id: "task.1", reason: "r", set: { specRefs } });

describe.each([
  ["create", create],
  ["patch", patch],
])("%s specRefs", (_name, parse) => {
  it("accepts knowledge:<atom-id>", () => {
    expect(parse(["knowledge:work-item-design-links"]).success).toBe(true);
  });

  it.each([
    "https://github.com/cogni-dao/node-template/pull/425",
    "work-item-design-links",
  ])("refuses %s and says where it belongs", (ref) => {
    const result = parse([ref]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(SPEC_REF_MESSAGE);
  });
});
