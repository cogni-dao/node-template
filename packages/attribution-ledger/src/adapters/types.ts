// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
type TextColumn = AnyPgColumn<{ data: string; notNull: true }>;
type NullableTextColumn = AnyPgColumn<{ data: string; notNull: false }>;
export interface AttributionIdentityTables {
  readonly userBindings: PgTable & {
    readonly userId: TextColumn;
    readonly provider: TextColumn;
    readonly externalId: TextColumn;
    readonly providerLogin: NullableTextColumn;
  };
  readonly userProfiles: PgTable & {
    readonly userId: TextColumn;
    readonly displayName: NullableTextColumn;
  };
}
export type AttributionQueryOperations = Pick<
  PostgresJsDatabase,
  "select" | "insert" | "update" | "delete" | "execute"
>;
export type AttributionDatabase = AttributionQueryOperations & {
  transaction<T>(
    run: (tx: AttributionQueryOperations) => Promise<T>
  ): Promise<T>;
};
