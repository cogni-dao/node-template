// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/payer-selection`
 * Purpose: PAYER_IS_AUTHORIZED at the run seam (story.0038 phase 2). A caller with a live payer binding is billed to the bound account and reads it in the owner's scope; a caller
 *   with none, a revoked one or a binding to a vanished account is billed to its own account; a failed binding read starts no run.
 * Side-effects: none
 */

import { describe, expect, it, vi } from "vitest";
import { payerScopeUserFor, selectRunPayer } from "@/app/_facades/ai/payer.server";

const OWN = { id: "acct-svc", ownerUserId: "svc" };
const ORG = { id: "acct-org", ownerUserId: "org1" };

const deps = (bound: string | null | Error, accounts: Record<string, { id: string; ownerUserId: string }> = { [ORG.id]: ORG, [OWN.id]: OWN }) => {
  const log = { info: vi.fn() };
  return {
    log,
    payerFor: vi.fn(async () => {
      if (bound instanceof Error) throw bound;
      return bound;
    }),
    getBillingAccountById: vi.fn(async (id: string) => accounts[id] ?? null),
  };
};

describe("selectRunPayer", () => {
  it("bills the bound org account and logs payer.selected", async () => {
    const d = deps(ORG.id);
    const payer = await selectRunPayer(d, { subjectUserId: "svc", own: OWN });
    expect(payer).toBe(ORG);
    expect(d.payerFor).toHaveBeenCalledWith("svc");
    expect(d.log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "payer.selected", subject: "svc", billingAccountId: "acct-org" }), "payer.selected");
  });

  it("bills the caller's own account with no binding (or after Off), without reading another account or logging a selection", async () => {
    const d = deps(null);
    expect(await selectRunPayer(d, { subjectUserId: "svc", own: OWN })).toBe(OWN);
    expect(d.getBillingAccountById).not.toHaveBeenCalled();
    expect(d.log.info).not.toHaveBeenCalled();
  });

  it("a binding to the caller's own account, or to an account that no longer exists, bills the caller's own account", async () => {
    expect(await selectRunPayer(deps(OWN.id), { subjectUserId: "svc", own: OWN })).toBe(OWN);
    expect(await selectRunPayer(deps("acct-gone"), { subjectUserId: "svc", own: OWN })).toBe(OWN);
  });

  it("a failed binding read throws, so no run starts on a guessed payer", async () => {
    await expect(selectRunPayer(deps(new Error("db down")), { subjectUserId: "svc", own: OWN })).rejects.toThrow("db down");
  });
});

describe("payerScopeUserFor (the run reads the bound account in its owner's scope)", () => {
  it("is the account owner only when the actor's live binding names exactly that account", async () => {
    expect(await payerScopeUserFor(deps(ORG.id), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("org1");
  });

  it("is the actor for its own account (no binding read) and for an account no binding names", async () => {
    const own = deps(ORG.id);
    expect(await payerScopeUserFor(own, { actorUserId: "svc", billingAccountId: OWN.id })).toBe("svc");
    expect(own.payerFor).not.toHaveBeenCalled();
    expect(await payerScopeUserFor(deps(null), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("svc");
    expect(await payerScopeUserFor(deps("acct-other"), { actorUserId: "svc", billingAccountId: ORG.id })).toBe("svc");
    expect(await payerScopeUserFor(deps(ORG.id), { actorUserId: "svc", billingAccountId: "acct-gone" })).toBe("svc");
  });
});
