// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Atomic consume-once store for short-lived node action assertion JTIs. */
export interface NodeActionReplayPort {
	consume(jti: string, ttlSeconds: number): Promise<boolean>;
}
