// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Node-owned Redis stream client; deep readiness reports connection failure. */
import Redis from "ioredis";

export function createStreamRedisClient(url: string): Redis {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  // ioredis otherwise prints arbitrary error stacks on unhandled error events.
  client.on("error", () => {});
  return client;
}
