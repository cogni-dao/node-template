// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/connections`
 * Purpose: Encrypted credential storage for external service connections (BYO-AI, tool auth).
 * Scope: Defines connections table per spec.tenant-connections schema. Does not contain encryption logic or broker queries.
 * Invariants:
 * - ENCRYPTED_AT_REST: Credentials stored as AEAD encrypted JSON blob, never plaintext columns.
 * - TENANT_SCOPED: Connections belong to billing_account_id. Cross-tenant access forbidden.
 * - SOFT_DELETE: Revocation sets revoked_at, never hard-deletes.
 * Side-effects: none (schema definitions only)
 * Links: docs/spec/tenant-connections.md
 * @public
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { billingAccounts, users } from "./refs";

/** Custom bytea type for encrypted credential blobs */
const bytea = customType<{ data: Buffer; dpiType: string }>({
  dataType() {
    return "bytea";
  },
});

const CONNECTION_PROVIDERS = [
  "openai-chatgpt",
  "openai-compatible",
  "github",
  "google",
  "bluesky",
  "cogni-node",
] as const;

const CREDENTIAL_TYPES = [
  "oauth2",
  "api_key",
  "app_password",
  "github_app_installation",
] as const;

/**
 * Encrypted connections for external services.
 * Per spec.tenant-connections: AEAD encrypted JSON blob with AAD binding
 * {billing_account_id, connection_id, provider}.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    serviceKeyDigest: text("service_key_digest"),
    serviceIdentity: jsonb("service_identity"),
    serviceOperationId: uuid("service_operation_id"),
    serviceGeneration: bigint("service_generation", { mode: "number" }),
    serviceCredentialId: uuid("service_credential_id"),
    serviceState: text("service_state"),
    renewUntil: timestamp("renew_until", { withTimezone: true }),
    credentialType: text("credential_type").notNull(),
    /** AEAD encrypted JSON blob (nonce prepended). Never store plaintext tokens. */
    encryptedCredentials: bytea("encrypted_credentials").notNull(),
    /** Key ID for rotation — matches env-provided key */
    encryptionKeyId: text("encryption_key_id").notNull(),
    /** OAuth scopes granted (empty array for non-OAuth types) */
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id").references(() => users.id),
  },
  (table) => [
    check(
      "connections_provider_check",
      sql`${table.provider} IN (${sql.join(
        CONNECTION_PROVIDERS.map((p) => sql.raw(`'${p}'`)),
        sql`, `
      )})`
    ),
    check(
      "connections_credential_type_check",
      sql`${table.credentialType} IN (${sql.join(
        CREDENTIAL_TYPES.map((t) => sql`${t}`),
        sql`, `
      )})`
    ),
    index("connections_billing_account_id_idx").on(table.billingAccountId),
    uniqueIndex("connections_billing_account_provider_active_idx")
      .on(table.billingAccountId, table.provider)
      .where(
        sql`${table.revokedAt} IS NULL AND ${table.provider} <> 'cogni-node'`
      ),
    uniqueIndex("connections_service_ready_unique")
      .on(table.serviceKeyDigest)
      .where(
        sql`${table.provider} = 'cogni-node' AND ${table.serviceState} = 'ready'`
      ),
  ]
).enableRLS();
