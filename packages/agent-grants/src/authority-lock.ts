// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared authority writer order. External policy/network reads belong before this boundary. */
import type { SqlTag } from "./postgres";

export async function lockUserAuthority(tx: SqlTag, userId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  await tx`SELECT user_id FROM agent_principals WHERE user_id = ${userId} FOR UPDATE`;
}

/** Capacity writers acquire admission before service identity, then the ordinary user advisory and principal. */
export async function lockServiceAuthority(tx: SqlTag, userId: string): Promise<void> {
  const rows = await tx`SELECT service_key FROM agent_principals WHERE user_id = ${userId}`;
  const serviceKey = rows[0]?.service_key;
  if (typeof serviceKey === "string") {
    await tx`SELECT pg_advisory_xact_lock(hashtext('agent_service_enrollments'))`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`service:${serviceKey}`}))`;
  }
  await lockUserAuthority(tx, userId);
}

export function assertCredentialPolicy(p: { ttlSec: number; renewWindowSec: number; pendingSec: number }): void {
  if (!Number.isSafeInteger(p.ttlSec) || p.ttlSec <= 0 || p.ttlSec > 30 * 86400 ||
      !Number.isSafeInteger(p.renewWindowSec) || p.renewWindowSec <= 0 || p.renewWindowSec > 14 * 86400 ||
      !Number.isSafeInteger(p.pendingSec) || p.pendingSec <= 0 || p.pendingSec > 15 * 60) {
    throw new Error("credential policy exceeds accepted lifetime bounds");
  }
}
