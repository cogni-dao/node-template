// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Durable host-only requester state. Full identity remains independent of its digest. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { connections } from "./connections";
import { billingAccounts } from "./refs";

export const agentServiceLinkOperations = pgTable(
  "agent_service_link_operations",
  {
    operationId: uuid("operation_id").primaryKey(),
    keyDigest: text("key_digest").notNull(),
    homeNodeId: uuid("home_node_id").notNull(),
    homeEnvironment: text("home_environment").notNull(),
    homeOrigin: text("home_origin").notNull(),
    service: text("service").notNull(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id),
    targetNodeId: uuid("target_node_id").notNull(),
    targetEnvironment: text("target_environment").notNull(),
    targetOrigin: text("target_origin").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    phase: text("phase").notNull(),
    current: boolean("current").notNull().default(true),
    /** Validated public state only; no token, device code or private cnf. */
    state: jsonb("state").notNull(),
    encryptedSecrets: text("encrypted_secrets"),
    revision: integer("revision").notNull().default(0),
    fence: integer("fence").notNull().default(0),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    secretDeadline: timestamp("secret_deadline", {
      withTimezone: true,
    }).notNull(),
    stagedConnectionId: uuid("staged_connection_id").references(
      () => connections.id
    ),
    confirmAuthorizedAt: timestamp("confirm_authorized_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
  },
  (t) => [
    // One retained current operation per full K; explicit replacement is an update under its CAS, never implicit ensure.
    uniqueIndex("agent_service_links_identity_unique")
      .on(
        t.homeNodeId,
        t.homeEnvironment,
        t.homeOrigin,
        t.service,
        t.billingAccountId,
        t.targetNodeId,
        t.targetEnvironment,
        t.targetOrigin
      )
      .where(sql`${t.current}`),
    uniqueIndex("agent_service_links_key_unique")
      .on(t.keyDigest)
      .where(sql`${t.current}`),
    index("agent_service_links_due_idx").on(t.nextAttemptAt, t.operationId),
    index("agent_service_links_staged_expiry_idx")
      .on(t.secretDeadline, t.operationId)
      .where(sql`${t.stagedConnectionId} IS NOT NULL AND COALESCE(${t.state}->>'quarantined','false') <> 'true' AND ${t.phase} <> 'expired'`),
    index("agent_service_links_secret_idx")
      .on(t.secretDeadline, t.operationId)
      .where(sql`${t.encryptedSecrets} IS NOT NULL`),
  ]
).enableRLS();

/** Fixed UTC-hour buckets; bounded two-bucket history per retained identity. */
export const agentServiceQuotas = pgTable(
  "agent_service_quotas",
  {
    subject: text("subject").notNull(),
    kind: text("kind").notNull(),
    hour: bigint("hour", { mode: "number" }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    uniqueIndex("agent_service_quotas_bucket_unique").on(
      t.subject,
      t.kind,
      t.hour
    ),
    index("agent_service_quotas_hour_idx").on(t.hour),
  ]
).enableRLS();
