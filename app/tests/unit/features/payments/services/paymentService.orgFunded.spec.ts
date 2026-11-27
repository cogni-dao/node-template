// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/payments/services/paymentService.orgFunded`
 * Purpose: Defects guarded: org.funded names whoever's poll verified the payment instead of the person who created it; a failed history hook blocks CREDITED or leaves the row missing forever; a repeated status read writes the row twice.
 * Scope: `getStatus` and `orgFundedLogger` over fake ports; confirmCreditsPayment (the money path) is mocked and untouched.
 * Side-effects: none
 * Links: src/features/payments/services/paymentService.ts
 * @public
 */

import type { PaymentAttempt } from "@cogni/node-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/config/repoSpec.server", () => ({
  getPaymentConfig: () => ({ revenueShare: 0 }),
}));
const confirm = vi.fn();
vi.mock("@/features/payments/services/creditsConfirm", () => ({
  confirmCreditsPayment: (...args: unknown[]) => confirm(...args),
}));

import { orgFundedLogger } from "@/app/_facades/payments/funding-account.server";
import type { Container } from "@/bootstrap/container";
import type { PostCreditFundingDeps } from "@/features/payments/application/confirmCreditsPurchase";
import { getStatus } from "@/features/payments/services/paymentService";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const OTHER_ADMIN = "22222222-2222-4222-8222-222222222222";
const WALLET = "0x070075F1389Ae1182aBac722B36CA12285d0c949";
const TX = "0xabc";
const REF = `11155111:${TX}`;

function attempt(status: PaymentAttempt["status"]): PaymentAttempt {
  return {
    id: "attempt-1",
    billingAccountId: "ba-org",
    fromAddress: WALLET,
    chainId: 11155111,
    txHash: TX,
    token: "0xtoken",
    toAddress: "0xto",
    amountRaw: 5_000_000n,
    amountUsdCents: 500,
    status,
    errorCode: null,
    createdByUserId: CREATOR,
    expiresAt: null,
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    lastVerifyAttemptAt: null,
    verifyAttemptCount: 0,
    createdAt: new Date(0),
  };
}

const log = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() }) as never;

function run(stored: { current: PaymentAttempt }, deps: PostCreditFundingDeps, logger = log()) {
  const userRepo = { findById: vi.fn(async () => stored.current) };
  const serviceRepo = {
    recordVerificationAttempt: vi.fn(async () => stored.current),
    updateStatus: vi.fn(async (_id: string, _ba: string, status: PaymentAttempt["status"]) => {
      stored.current = { ...stored.current, status };
      return stored.current;
    }),
  };
  const verifier = { verify: vi.fn(async () => ({ status: "VERIFIED", actualFrom: WALLET })) };
  const read = () =>
    getStatus(
      userRepo as never,
      serviceRepo as never,
      {} as never,
      {} as never,
      verifier as never,
      { now: () => new Date("2026-01-01T00:00:00Z").toISOString() } as never,
      logger,
      { attemptId: "attempt-1", billingAccountId: "ba-org", defaultVirtualKeyId: "vk" },
      deps,
    );
  return { read, serviceRepo, logger };
}

/** An identity double that dedupes on paymentRef like `logOrgFunded` does. */
function identity() {
  const rows = new Map<string, { actorUserId: string }>();
  const logOrgFunded = vi.fn(async (input: { actorUserId: string; paymentRef: string }) => {
    const recorded = !rows.has(input.paymentRef);
    if (recorded) rows.set(input.paymentRef, { actorUserId: input.actorUserId });
    return { recorded };
  });
  return { rows, logOrgFunded, container: { agentAuthority: { logOrgFunded } } as unknown as Container };
}

const deps = (onCredited: PostCreditFundingDeps["onCredited"], logger = log()): PostCreditFundingDeps => ({
  treasurySettlement: undefined,
  financialLedger: undefined,
  log: logger,
  onCredited,
});

describe("org.funded on a credited org top-up", () => {
  beforeEach(() => confirm.mockReset());

  it("names the person who created the attempt, not the second admin whose poll verified it", async () => {
    const id = identity();
    const stored = { current: attempt("PENDING_UNVERIFIED") };
    const { read } = run(stored, deps(orgFundedLogger(id.container, OTHER_ADMIN)));

    const out = await read();

    expect(out.status).toBe("CREDITED");
    expect(id.logOrgFunded).toHaveBeenCalledTimes(1);
    expect(id.rows.get(REF)?.actorUserId).toBe(CREATOR);
  });

  it("falls back to the caller only for an attempt created before its creator was recorded", async () => {
    const id = identity();
    const stored = { current: { ...attempt("PENDING_UNVERIFIED"), createdByUserId: null } };
    const { read } = run(stored, deps(orgFundedLogger(id.container, OTHER_ADMIN)));

    await read();

    expect(id.rows.get(REF)?.actorUserId).toBe(OTHER_ADMIN);
  });

  it("a throwing hook does not block CREDITED, and the failure line carries the paymentRef", async () => {
    const stored = { current: attempt("PENDING_UNVERIFIED") };
    const logger = log();
    const { read, serviceRepo } = run(stored, deps(vi.fn().mockRejectedValue(new Error("history down")), logger), logger);

    const out = await read();

    expect(out.status).toBe("CREDITED");
    expect(serviceRepo.updateStatus).toHaveBeenCalledWith("attempt-1", "ba-org", "CREDITED");
    expect((logger as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRef: REF }),
      "onCredited failed for payment attempt",
    );
  });

  it("a later status read of the CREDITED attempt writes the row a failed hook missed, once", async () => {
    const id = identity();
    id.logOrgFunded.mockRejectedValueOnce(new Error("history down"));
    const stored = { current: attempt("PENDING_UNVERIFIED") };
    const { read } = run(stored, deps(orgFundedLogger(id.container, OTHER_ADMIN)));

    await read();
    expect(id.rows.size).toBe(0);

    await read();
    await read();

    expect(id.rows.size).toBe(1);
    expect(id.rows.get(REF)?.actorUserId).toBe(CREATOR);
  });

  it("a hook failing on a later read of a CREDITED attempt still answers CREDITED", async () => {
    const stored = { current: attempt("CREDITED") };
    const { read } = run(stored, deps(vi.fn().mockRejectedValue(new Error("history down"))));

    expect((await read()).status).toBe("CREDITED");
  });
});
