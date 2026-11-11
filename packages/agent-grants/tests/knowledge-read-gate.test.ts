// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * SERVICE_KEYED_GATE (story.0038): the `knowledge.read` door gates ONLY a principal made by a service enrollment. An existing agent key
 * (no `service_key`) and a signed-in human pass exactly as before, so no existing key changes behavior. An enrolled service needs an
 * approved `knowledge:read` role row: 403 before the admin's click, 200 after, 403 again when switched Off.
 */

import { describe, expect, it } from "vitest";
import { type AdminCheck, authorizeCaller, ROUTE_ONLY_CAPABILITIES } from "../src";
import { memoryStore } from "./memory-store";

const cap = ROUTE_ONLY_CAPABILITIES["knowledge.read"];
if (!cap) throw new Error("knowledge.read must be declared");
const denyAdmin: AdminCheck = async () => "denied";
const door = (store: ReturnType<typeof memoryStore>, userId: string, via: "bearer" | "session") =>
  authorizeCaller(store, denyAdmin, { userId, via, requires: cap.requires, serviceKeyedOnly: cap.serviceKeyedOnly });

describe("knowledge.read declaration", () => {
  it("is route-only, node scope, member subject, named in plain words, and gates service principals only", () => {
    expect(cap.requires).toMatchObject({ scope: "knowledge:read", kind: "node", subject: "member", label: "Read the knowledge base" });
    expect(cap.serviceKeyedOnly).toBe(true);
  });

  it("covers every knowledge GET route", () => {
    expect([...cap.routes].sort()).toEqual(
      [
        "knowledge.browse",
        "knowledge.contributions.commits.list",
        "knowledge.contributions.diff",
        "knowledge.contributions.get",
        "knowledge.contributions.list",
        "knowledge.domains.get",
        "knowledge.domains.list",
        "knowledge.get",
        "knowledge.graph",
        "knowledge.history",
        "knowledge.index",
        "knowledge.list",
      ].sort()
    );
  });
});

describe("knowledge.read door", () => {
  it("an existing agent (no service_key) reads with no role row", async () => {
    expect(await door(memoryStore(), "old-agent", "bearer")).toEqual({ decision: "allow", basis: "agent_without_service_key" });
  });

  it("a signed-in human reads with no role row", async () => {
    expect(await door(memoryStore(), "human", "session")).toMatchObject({ decision: "allow", basis: "signed_in" });
  });

  it("an enrolled service is 403 before the admin's click, 200 after, and 403 again when switched Off", async () => {
    const store = memoryStore({ servicePrincipals: ["svc"], roles: [{ principal: "svc", scope: "knowledge:read", pending: true }] });
    expect(await door(store, "svc", "bearer")).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_role" });
    store.roles[0]!.approvedBy = "admin";
    expect(await door(store, "svc", "bearer")).toMatchObject({ decision: "allow", basis: "role" });
    store.roles[0]!.revoked = true;
    expect(await door(store, "svc", "bearer")).toMatchObject({ decision: "deny", reason: "no_role" });
  });

  it("an enrolled service never reads on the strength of an existing agent's rule: no role row, no read", async () => {
    expect(await door(memoryStore({ servicePrincipals: ["svc"] }), "svc", "bearer")).toMatchObject({ decision: "deny" });
  });

  it("a store outage while telling the kind of principal is authz_unavailable, never an allow", async () => {
    expect(await door(memoryStore({ failing: true }), "any", "bearer")).toMatchObject({ decision: "deny", code: "authz_unavailable" });
  });

  it("a store that cannot tell the kind applies the ordinary role-row rule (fail strict)", async () => {
    const store = memoryStore();
    const blind = { ...store, isServicePrincipal: undefined };
    expect(await authorizeCaller(blind, denyAdmin, { userId: "x", via: "bearer", requires: cap.requires, serviceKeyedOnly: true })).toMatchObject({
      decision: "deny",
      reason: "no_role",
    });
  });

  it("without the flag the ordinary rule applies to everyone", async () => {
    expect(await authorizeCaller(memoryStore(), denyAdmin, { userId: "old-agent", via: "bearer", requires: cap.requires })).toMatchObject({ decision: "deny" });
  });
});
