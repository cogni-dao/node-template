// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { createPostgresPayerBindingStore, isPayerRefusedError, PayerRefusedError, payerFor, payerScopeUserFor, selectRunPayer, type SqlTag } from "../src";

describe("selectRunPayer and payerScopeUserFor (pure run-path decisions)", () => {
  const OWN = { id: "acct-svc", ownerUserId: "svc" };
  const ORG = { id: "acct-org", ownerUserId: "org1" };
  const deps = (bound: string | null | Error) => ({
    payerFor: vi.fn(async () => {
      if (bound instanceof Error) throw bound;
      return bound;
    }),
    getAccount: vi.fn(async (id: string) => ({ [ORG.id]: ORG, [OWN.id]: OWN })[id] ?? null),
  });

  it("bills the bound account only for a live binding that names another, existing account", async () => {
    expect(await selectRunPayer(deps(ORG.id), { subjectUserId: "svc", own: OWN })).toEqual({ account: ORG, bound: true });
    const none = deps(null);
    expect(await selectRunPayer(none, { subjectUserId: "svc", own: OWN })).toEqual({ account: OWN, bound: false });
    expect(none.getAccount).not.toHaveBeenCalled();
    expect((await selectRunPayer(deps(OWN.id), { subjectUserId: "svc", own: OWN })).bound).toBe(false);
    expect(await selectRunPayer(deps("acct-gone"), { subjectUserId: "svc", own: OWN })).toEqual({ account: OWN, bound: false });
  });

  it("a failed binding read throws, so no run starts on a guessed payer", async () => {
    await expect(selectRunPayer(deps(new Error("db down")), { subjectUserId: "svc", own: OWN })).rejects.toThrow("db down");
  });

  it("a refusal from the resolver reaches the caller, never a silent fall back to the caller's own account", async () => {
    for (const code of ["org_suspended", "org_link_closed"] as const)
      await expect(selectRunPayer(deps(new PayerRefusedError(code)), { subjectUserId: "svc", own: OWN })).rejects.toMatchObject({ code });
  });

  it("the run reads the bound account in its owner's scope only when the actor's live binding names exactly that account", async () => {
    expect(await payerScopeUserFor(deps(ORG.id), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("org1");
    const own = deps(ORG.id);
    expect(await payerScopeUserFor(own, { actorUserId: "svc", billingAccountId: OWN.id })).toBe("svc");
    expect(own.payerFor).not.toHaveBeenCalled();
    expect(await payerScopeUserFor(deps(null), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("svc");
    expect(await payerScopeUserFor(deps("acct-other"), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("svc");
    expect(await payerScopeUserFor(deps(ORG.id), { actorUserId: "svc", billingAccountId: "acct-gone" })).toBe("svc");
  });
});

describe("the Postgres payer resolver reads the subject's latest approved binding", () => {
  const read = (row: Record<string, unknown> | null) => createPostgresPayerBindingStore(vi.fn(async () => (row ? [row] : [])) as unknown as SqlTag);
  const live = { billing_account_id: "acct-org", approved_by: "org1", revoked_at: null, link_id: "l1", link_closed_at: null, suspended_at: null };

  it("a live binding names its account; no binding names none", async () => {
    expect(await payerFor(read(live), "svc")).toBe("acct-org");
    expect(await payerFor(read(null), "svc")).toBeNull();
  });

  it("a live binding to a suspended org is org_suspended", async () => {
    await expect(payerFor(read({ ...live, suspended_at: "2026-11-20T00:00:00.000Z" }), "svc")).rejects.toMatchObject({ code: "org_suspended" });
  });

  it("a revoked binding that a closed link wrote is org_link_closed; a revoked binding no link wrote is the caller's own account again", async () => {
    const closed = { ...live, revoked_at: "2026-11-20T00:00:00.000Z", link_closed_at: "2026-11-20T00:00:00.000Z" };
    await expect(payerFor(read(closed), "svc")).rejects.toMatchObject({ code: "org_link_closed" });
    expect(await payerFor(read({ ...closed, link_id: null, link_closed_at: null }), "svc")).toBeNull();
  });

  it("a live binding under a closed link (a bind that raced the close) is org_link_closed, never a bill", async () => {
    await expect(payerFor(read({ ...live, link_closed_at: "2026-11-20T00:00:00.000Z" }), "svc")).rejects.toMatchObject({ code: "org_link_closed" });
  });

  it("only a binding a link wrote can bill: the query ignores rows with no link (the retired ask flow wrote those)", async () => {
    const sql = vi.fn(async () => []);
    await createPostgresPayerBindingStore(sql as unknown as SqlTag).payerFor("svc");
    expect((sql.mock.calls[0] as unknown as [TemplateStringsArray])[0].join("?")).toContain("b.link_id IS NOT NULL");
  });

  it("reads only approved rows, newest first, on every call", async () => {
    const sql = vi.fn(async () => []);
    const store = createPostgresPayerBindingStore(sql as unknown as SqlTag);
    await store.payerFor("svc");
    await store.payerFor("svc");
    expect(sql).toHaveBeenCalledTimes(2);
    const text = (sql.mock.calls[0] as unknown as [TemplateStringsArray])[0].join("?");
    expect(text).toContain("approved_by IS NOT NULL");
    expect(text).toContain("ORDER BY (b.revoked_at IS NULL) DESC, b.created_at DESC");
  });

  it("isPayerRefusedError recognises the error and nothing else", () => {
    expect(isPayerRefusedError(new PayerRefusedError("org_suspended"))).toBe(true);
    expect(isPayerRefusedError(new Error("x"))).toBe(false);
    expect(isPayerRefusedError(null)).toBe(false);
  });
});
