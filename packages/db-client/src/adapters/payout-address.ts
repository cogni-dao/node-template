// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/db-client/adapters/payout-address`
 * Purpose: The one place an earner (a `users.id`) becomes a payout address. Used by the claimant resolver and by the settlement append's ownership check, so both agree.
 * Scope: SELECT-only over `payout_addresses` and `payout_beneficiaries`. Never touches `user_bindings` or `users.wallet_address`.
 * Invariants:
 * - AUTH_IS_NOT_PAYMENT: only the payout config decides a payee. A sign-in or admin wallet never does, and the principal's kind never does.
 * - NO_ADDRESS_IS_HELD: an earner with no payout address (or whose accepted beneficiary has none) is absent from the result: the claim is held, never redirected.
 * - BENEFICIARY_IS_ACCEPTED: an earner with an accepted beneficiary row in force at `asOf` is paid to the BENEFICIARY's payout address and to no other, even
 *   when the earner has an address of its own. The earner is never rewritten; only the destination moves.
 * - FREEZE_AT_CUTOFF: the beneficiary row is read as of `asOf` (accepted_at <= asOf, not revoked at asOf). A later accept, revoke or re-propose never changes an earlier cutoff.
 * Side-effects: IO (database reads)
 * Links: https://node-template.cognidao.org/knowledge/node-economic-identity
 * @internal
 */

import type { HexAddress } from "@cogni/aragon-osx";
import { payoutAddresses, payoutBeneficiaries } from "@cogni/db-schema/identity";
import { and, inArray, isNotNull, isNull, lte, or, gt } from "drizzle-orm";

import type { Database } from "../client";

/** A Drizzle connection or transaction: anything that can SELECT. */
export type PayoutReader = Pick<Database, "select">;

/** earner `users.id` to its lowercase payout address as of `asOf`. An earner that is held is absent. */
export async function resolvePayoutAddresses(
  db: PayoutReader,
  earnerUserIds: readonly string[],
  asOf: Date
): Promise<Map<string, HexAddress>> {
  const result = new Map<string, HexAddress>();
  const earners = [...new Set(earnerUserIds)];
  if (earners.length === 0) return result;

  const accepted = await db
    .select({
      earnerUserId: payoutBeneficiaries.earnerUserId,
      beneficiaryUserId: payoutBeneficiaries.beneficiaryUserId,
    })
    .from(payoutBeneficiaries)
    .where(
      and(
        inArray(payoutBeneficiaries.earnerUserId, earners),
        isNotNull(payoutBeneficiaries.acceptedAt),
        lte(payoutBeneficiaries.acceptedAt, asOf),
        or(
          isNull(payoutBeneficiaries.revokedAt),
          gt(payoutBeneficiaries.revokedAt, asOf)
        )
      )
    );
  const beneficiaryByEarner = new Map<string, string>();
  for (const row of accepted) {
    if (row.beneficiaryUserId)
      beneficiaryByEarner.set(row.earnerUserId, row.beneficiaryUserId);
  }

  const payees = [
    ...new Set(
      earners.map((earner) => beneficiaryByEarner.get(earner) ?? earner)
    ),
  ];
  const rows = await db
    .select({
      userId: payoutAddresses.userId,
      address: payoutAddresses.address,
    })
    .from(payoutAddresses)
    .where(inArray(payoutAddresses.userId, payees));
  const addressByPayee = new Map(rows.map((r) => [r.userId, r.address]));

  for (const earner of earners) {
    const address = addressByPayee.get(beneficiaryByEarner.get(earner) ?? earner);
    if (address) result.set(earner, address as HexAddress);
  }
  return result;
}
