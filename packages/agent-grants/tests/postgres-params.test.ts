// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * NO_DATE_PARAMETERS: the node hands the Postgres store drizzle's postgres.js client, which replaces the timestamp serializers, so a JS Date parameter fails there
 * (ERR_INVALID_ARG_TYPE) although a bare postgres.js client takes it (candidate-a 11-13: every ask was a 503). This test drives every store method with a tag that
 * refuses a Date parameter, so the class cannot return through any method.
 */

import { describe, expect, it } from "vitest";
import { createPostgresAgentGrantsStore, type SqlTag } from "../src";

const refusesDates = (seen: unknown[][]): SqlTag =>
  ((strings: TemplateStringsArray, ...values: unknown[]) => {
    seen.push(values);
    for (const v of values) if (v instanceof Date) return Promise.reject(Object.assign(new TypeError("Date parameter"), { code: "ERR_INVALID_ARG_TYPE" }));
    const text = strings.join("?");
    // An insert lands; every read finds nothing; a count is zero.
    if (text.includes("INSERT")) return Promise.resolve([{ id: "r1" }]);
    if (text.includes("count(*)")) return Promise.resolve([{ n: 0 }]);
    return Promise.resolve([]);
  }) as unknown as SqlTag;

describe("the Postgres store passes no JS Date as a parameter", () => {
  it("an ask (new row, and a re-ask) sends the link end as an ISO string", async () => {
    const seen: unknown[][] = [];
    const store = createPostgresAgentGrantsStore(refusesDates(seen));
    const link = { hash: "h".repeat(64), expiresAt: new Date("2026-11-14T00:00:00.000Z") };
    for (const resource of ["node", "account"] as const)
      await expect(store.requestRole({ principalUserId: "u", scope: "s", resource, link, maxPending: 3, maxPendingTotal: 50 })).resolves.toBe("created");
    expect(seen.flat()).toContain("2026-11-14T00:00:00.000Z");
    expect(seen.flat().some((v) => v instanceof Date)).toBe(false);
  });

  it("the other methods take no Date either", async () => {
    const seen: unknown[][] = [];
    const store = createPostgresAgentGrantsStore(refusesDates(seen));
    await store.hasLiveRole("u", "s");
    await store.liveScopes("u", ["s"]);
    await store.hasLiveAccountGrant("u", "s", "a");
    await store.liveAccountScopes("u", ["s"], "a");
    await store.listRoleRows(5);
    await store.listAccountRoleRows("a", 5);
    await store.listOwnRoles("u");
    await store.approvePending({ principalUserId: "p", scope: "s", approvedBy: "a" });
    await store.denyPending({ principalUserId: "p", scope: "s" });
    await store.insertRole({ principalUserId: "p", scope: "s", approvedBy: "a" });
    await store.revokeRole({ principalUserId: "p", scope: "s" });
    await store.findPendingByLink({ linkHash: "h", resource: "account" });
    await store.approveAccountByLink({ linkHash: "h", approvedBy: "a", days: 7 });
    await store.denyAccountByLink({ linkHash: "h", deniedBy: "a" });
    await store.insertAccountRole({ principalUserId: "p", scope: "s", approvedBy: "a", days: 7 });
    await store.revokeAccountRole({ rowId: "r", ownerUserId: "o" });
    expect(seen.flat().some((v) => v instanceof Date)).toBe(false);
  });
});
