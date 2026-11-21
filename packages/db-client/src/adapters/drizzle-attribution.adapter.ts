// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Node-local schema binding only. All queries and transaction checks live in the public package.
import { bindDrizzleAttributionAdapter } from "@cogni/attribution-ledger/adapters/postgres";
import * as attributionSchema from "@cogni/db-schema/attribution";
import { userBindings } from "@cogni/db-schema/identity";
import { userProfiles } from "@cogni/db-schema/profile";
export const DrizzleAttributionAdapter = bindDrizzleAttributionAdapter(
  attributionSchema,
  { userBindings, userProfiles }
);
export type DrizzleAttributionAdapter = InstanceType<
  typeof DrizzleAttributionAdapter
>;
