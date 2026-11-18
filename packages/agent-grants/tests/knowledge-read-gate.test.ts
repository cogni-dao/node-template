// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The `knowledge.read` door for an enrolled service (story.0038). The door itself is the ordinary one (a bearer needs an approved `knowledge:read`
 * row, a human passes), so an enrolled service is 403 before the admin's click, 200 after, and 403 again when switched Off. What is specific to a
 * service is that its key reaches NOTHING else: that gate (SERVICE_KEY_DENY_BY_DEFAULT) lives in the node's route wrapper and is tested there.
 */

import { describe, expect, it } from "vitest";
import { type AdminCheck, authorizeCaller, ROUTE_ONLY_CAPABILITIES } from "../src";
import { memoryStore } from "./memory-store";

const cap = ROUTE_ONLY_CAPABILITIES["knowledge.read"];
if (!cap) throw new Error("knowledge.read must be declared");
const denyAdmin: AdminCheck = async () => "denied";
const door = (store: ReturnType<typeof memoryStore>, userId: string, via: "bearer" | "session") =>
  authorizeCaller(store, denyAdmin, { userId, via, requires: cap.requires });

describe("knowledge.read door for an enrolled service", () => {
  it("is 403 before the admin's click, 200 after, and 403 again when switched Off", async () => {
    const store = memoryStore({ servicePrincipals: ["svc"], roles: [{ principal: "svc", scope: "knowledge:read", pending: true }] });
    expect(await door(store, "svc", "bearer")).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_role" });
    store.roles[0]!.approvedBy = "admin";
    expect(await door(store, "svc", "bearer")).toMatchObject({ decision: "allow", basis: "role" });
    store.roles[0]!.revoked = true;
    expect(await door(store, "svc", "bearer")).toMatchObject({ decision: "deny", reason: "no_role" });
  });

  it("a signed-in human reads with no role row", async () => {
    expect(await door(memoryStore(), "human", "session")).toMatchObject({ decision: "allow", basis: "signed_in" });
  });

  it("a switched-Off service still lists as a restorable control, so the admin can turn it back On without a new ask", async () => {
    const store = memoryStore({
      servicePrincipals: ["svc"],
      roles: [{ principal: "svc", scope: "knowledge:read", approvedBy: "admin", revoked: true }],
    });
    const listed = await store.listRoleRows(10);
    expect(listed.rows.map((r) => [r.principalUserId, r.state])).toEqual([["svc", "revoked"]]);
  });

  it("tells a service principal from any other agent", async () => {
    const store = memoryStore({ servicePrincipals: ["svc"] });
    expect(await store.isServicePrincipal?.("svc")).toBe(true);
    expect(await store.isServicePrincipal?.("other")).toBe(false);
  });
});
