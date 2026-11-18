// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/identity/payout`
 * Purpose: Payout config writes and reads: a principal's own payout address (task.0153) and the one beneficiary row that sends an AI's earnings to a human (task.0154).
 * Scope: Service-role reads/writes of `payout_addresses` and `payout_beneficiaries` only. Never reads `user_bindings` or `users.wallet_address` (AUTH_IS_NOT_PAYMENT).
 * Invariants:
 *   - OWN_ROW_ONLY: every function acts on the caller's own address or its own side of the beneficiary row; the caller id comes from the credential, never the body.
 *   - BENEFICIARY_IS_ACCEPTED: the AI proposes (a one-time token, hashed at rest); only a human session that holds the token accepts, and becomes the beneficiary. The earner is never rewritten.
 *   - NO_SELF_ACCEPTANCE: the earner cannot accept its own proposal (database check `payout_beneficiaries_no_self_benefit`, and the accept filter).
 *   - REVOKE_KEEPS_HISTORY: revoking sets `revoked_at`; the row stays, so earlier cutoffs still resolve as they did (FREEZE_AT_CUTOFF).
 * Side-effects: IO (service-role database)
 * Links: packages/db-client/src/adapters/payout-address.ts
 * @internal
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, ne } from "drizzle-orm";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { payoutAddresses, payoutBeneficiaries, users } from "@/shared/db/schema";

const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export async function getPayoutAddress(userId: string): Promise<string | null> {
  const [row] = await getServiceDb().select({ address: payoutAddresses.address }).from(payoutAddresses).where(eq(payoutAddresses.userId, userId));
  return row?.address ?? null;
}

/** The caller's own payout address. A setting, not a proof; `address` is already validated and lowercased by the route. */
export async function setPayoutAddress(userId: string, address: string): Promise<void> {
  await getServiceDb()
    .insert(payoutAddresses)
    .values({ userId, address })
    .onConflictDoUpdate({ target: payoutAddresses.userId, set: { address, updatedAt: new Date() } });
}

export type ProposeResult = { status: "pending"; token: string; expiresAt: Date } | { status: "accepted" };

/** AI side: one live row per earner. A repeat while pending issues a new token; while accepted it changes nothing. */
export async function proposeBeneficiary(earnerUserId: string): Promise<ProposeResult> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  return getServiceDb().transaction(async (tx) => {
    const [live] = await tx
      .select({ id: payoutBeneficiaries.id, acceptedAt: payoutBeneficiaries.acceptedAt })
      .from(payoutBeneficiaries)
      .where(and(eq(payoutBeneficiaries.earnerUserId, earnerUserId), isNull(payoutBeneficiaries.revokedAt)))
      .for("update");
    if (live?.acceptedAt) return { status: "accepted" } as const;
    if (live) {
      await tx.update(payoutBeneficiaries).set({ linkHash: hashToken(token), linkExpiresAt: expiresAt }).where(eq(payoutBeneficiaries.id, live.id));
    } else {
      await tx.insert(payoutBeneficiaries).values({ id: randomUUID(), earnerUserId, linkHash: hashToken(token), linkExpiresAt: expiresAt });
    }
    return { status: "pending", token, expiresAt } as const;
  });
}

/** AI side: the state of its own live row. */
export async function beneficiaryStatus(earnerUserId: string): Promise<{ status: "none" | "pending" | "accepted"; acceptedAt: Date | null }> {
  const [live] = await getServiceDb()
    .select({ acceptedAt: payoutBeneficiaries.acceptedAt })
    .from(payoutBeneficiaries)
    .where(and(eq(payoutBeneficiaries.earnerUserId, earnerUserId), isNull(payoutBeneficiaries.revokedAt)));
  if (!live) return { status: "none", acceptedAt: null };
  return { status: live.acceptedAt ? "accepted" : "pending", acceptedAt: live.acceptedAt };
}

/** Human side: the signed-in person accepts by the one-time token. Wrong, used, expired and own-AI tokens all answer false. */
export async function acceptBeneficiary(sessionUserId: string, token: string): Promise<boolean> {
  const rows = await getServiceDb()
    .update(payoutBeneficiaries)
    .set({ beneficiaryUserId: sessionUserId, acceptedAt: new Date(), linkHash: null })
    .where(
      and(
        eq(payoutBeneficiaries.linkHash, hashToken(token)),
        ne(payoutBeneficiaries.earnerUserId, sessionUserId),
        gt(payoutBeneficiaries.linkExpiresAt, new Date()),
        isNull(payoutBeneficiaries.acceptedAt),
        isNull(payoutBeneficiaries.revokedAt)
      )
    )
    .returning({ id: payoutBeneficiaries.id });
  return rows.length === 1;
}

export interface MineBeneficiary {
  readonly id: string;
  readonly earnerUserId: string;
  readonly earnerName: string | null;
  readonly acceptedAt: Date;
}

/** Human side: the AIs whose earnings this person has accepted. */
export async function listMineBeneficiaries(userId: string): Promise<MineBeneficiary[]> {
  const rows = await getServiceDb()
    .select({
      id: payoutBeneficiaries.id,
      earnerUserId: payoutBeneficiaries.earnerUserId,
      earnerName: users.name,
      acceptedAt: payoutBeneficiaries.acceptedAt,
    })
    .from(payoutBeneficiaries)
    .innerJoin(users, eq(users.id, payoutBeneficiaries.earnerUserId))
    .where(and(eq(payoutBeneficiaries.beneficiaryUserId, userId), isNotNull(payoutBeneficiaries.acceptedAt), isNull(payoutBeneficiaries.revokedAt)));
  return rows.flatMap((r) => (r.acceptedAt ? [{ ...r, acceptedAt: r.acceptedAt }] : []));
}

/** Either side ends the live row: the beneficiary by row id (profile), the earner by its own id (its key). True when a live row ended. */
export async function revokeBeneficiary(by: { beneficiaryUserId: string; rowId: string } | { earnerUserId: string }): Promise<boolean> {
  const side =
    "rowId" in by
      ? and(eq(payoutBeneficiaries.id, by.rowId), eq(payoutBeneficiaries.beneficiaryUserId, by.beneficiaryUserId))
      : eq(payoutBeneficiaries.earnerUserId, by.earnerUserId);
  const rows = await getServiceDb()
    .update(payoutBeneficiaries)
    .set({ revokedAt: new Date(), linkHash: null })
    .where(and(side, isNull(payoutBeneficiaries.revokedAt)))
    .returning({ id: payoutBeneficiaries.id });
  return rows.length > 0;
}
