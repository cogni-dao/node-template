// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/identity`
 * Purpose: User identity binding tables — links external accounts (wallet, Discord, GitHub, Google) to users.
 * Scope: Defines user_bindings (current-state index) and identity_events (append-only audit trail). Does not contain queries or business logic.
 * Invariants:
 * - BINDINGS_ARE_EVIDENCED: Proof lives in identity_events.payload, not on the binding row.
 * - NO_AUTO_MERGE: UNIQUE(provider, external_id) — same external ID for same provider can't bind to two users.
 * - APPEND_ONLY_EVENTS: identity_events rows are append-only; DB trigger rejects UPDATE/DELETE.
 * - USER_ID_AT_CREATION: All FKs reference users.id (UUID).
 * - RLS_ENABLED: Both tables have row-level security enabled.
 * - AUTH_IS_NOT_PAYMENT: `payout_addresses` + `payout_beneficiaries` (below) are the only payout config; claimant resolution never reads the binding tables for a wallet.
 * Side-effects: none (schema definitions only)
 * @public
 */

import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	jsonb,
	pgPolicy,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./refs";

/**
 * User bindings — current-state index linking external accounts to users.
 * Proof/evidence lives in identity_events.payload, not here.
 * UNIQUE(provider, external_id) enforces NO_AUTO_MERGE at the DB level.
 */
export const userBindings = pgTable(
	"user_bindings",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		provider: text("provider").notNull(),
		externalId: text("external_id").notNull(),
		providerLogin: text("provider_login"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"user_bindings_provider_check",
			sql`${table.provider} IN ('wallet', 'discord', 'github', 'google')`,
		),
		uniqueIndex("user_bindings_provider_external_id_unique").on(
			table.provider,
			table.externalId,
		),
		index("user_bindings_user_id_idx").on(table.userId),
		// ONE_WALLET_ONE_KEY: a wallet is keyed by its lowercase address; two owners can never hold the same wallet in different casing.
		uniqueIndex("user_bindings_wallet_lower_unique")
			.on(table.provider, sql`lower(${table.externalId})`)
			.where(sql`${table.provider} = 'wallet'`),
	],
).enableRLS();

/**
 * Link transactions — server-side records for fail-closed account linking.
 * Created when a user initiates an OAuth link, consumed atomically in the
 * NextAuth callback. If consumption fails (expired, already consumed, tampered),
 * the link is rejected — never silently falls through to new-user creation.
 */
export const linkTransactions = pgTable(
	"link_transactions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		provider: text("provider").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"link_transactions_provider_check",
			sql`${table.provider} IN ('github', 'discord', 'google', 'wallet')`,
		),
		index("link_transactions_user_id_idx").on(table.userId),
		pgPolicy("tenant_isolation", {
			using: sql`${table.userId} = current_setting('app.current_user_id', true)`,
			withCheck: sql`${table.userId} = current_setting('app.current_user_id', true)`,
		}),
	],
).enableRLS();

export type LinkTransaction = InferSelectModel<typeof linkTransactions>;

/**
 * Identity events — append-only audit trail for binding lifecycle.
 * DB trigger rejects UPDATE/DELETE (APPEND_ONLY_EVENTS).
 * Revocation creates a new event, never deletes rows.
 */
export const identityEvents = pgTable(
	"identity_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		eventType: text("event_type").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"identity_events_event_type_check",
			sql`${table.eventType} IN ('bind', 'revoke', 'merge')`,
		),
		index("identity_events_user_id_idx").on(table.userId),
	],
).enableRLS();

/**
 * Pre-session challenges for operator-attested GitHub SIGN-IN (task.5042).
 *
 * Distinct from `link_transactions` on purpose. That table is the LINK flow's nonce and
 * is structurally user-owned — `user_id` is NOT NULL, references `users`, and carries an
 * RLS policy keyed on `app.current_user_id`. A sign-in challenge is minted BEFORE any
 * local user exists, so it cannot borrow that row shape without weakening a live policy.
 *
 * Stores the nonce HASH, never the nonce: the plaintext travels in the URL and inside the
 * operator's signed attestation, so a database read must not be enough to replay one.
 * The browser holds the plaintext in an HttpOnly cookie, and `authorize()` requires the
 * cookie to match the attestation's `nonce` claim (SIGNIN_NONCE_IS_COOKIE_BOUND) — without
 * that pairing a leaked attestation would mint a session on its own.
 *
 * Service-role only. RLS is enabled with NO policy, which is deny-all for `app_user`.
 */
export const identitySigninChallenges = pgTable(
	"identity_signin_challenges",
	{
		id: text("id").primaryKey(),
		nonceHash: text("nonce_hash").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("identity_signin_challenges_expires_at_idx").on(table.expiresAt),
	],
).enableRLS();

export type IdentitySigninChallenge = InferSelectModel<
	typeof identitySigninChallenges
>;

/**
 * PAYOUT CONFIG (task.0153, AUTH_IS_NOT_PAYMENT). Where a principal's earnings go is its own setting, like a billing address. It is never read from
 * `user_bindings` (the sign-in and admin wallets) or `users.wallet_address`. No row = unpaid: the claim is held, whatever the principal's kind.
 * Service-role writes only: ENABLE + FORCE RLS, no policy (the migration adds FORCE).
 */
export const payoutAddresses = pgTable(
	"payout_addresses",
	{
		userId: text("user_id")
			.primaryKey()
			.references(() => users.id),
		/** Lowercase 0x address. A setting, not a proof: the owner chooses where to be paid. */
		address: text("address").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		check(
			"payout_addresses_address_lower_hex",
			sql`${table.address} ~ '^0x[0-9a-f]{40}$'`,
		),
	],
).enableRLS();

/**
 * BENEFICIARY ROW (task.0154, BENEFICIARY_IS_ACCEPTED). One live row per AI earner: the AI proposes with its key (the row holds only the hash of a one-time
 * link token), the human accepts signed in on /profile (the session user becomes `beneficiary_user_id`). An accepted row is in force from `accepted_at` until
 * `revoked_at`; claimant resolution reads it as of the liability's cutoff (FREEZE_AT_CUTOFF). The earner is never rewritten.
 * Service-role writes only: ENABLE + FORCE RLS, no policy (the migration adds FORCE).
 */
export const payoutBeneficiaries = pgTable(
	"payout_beneficiaries",
	{
		id: text("id").primaryKey(),
		earnerUserId: text("earner_user_id")
			.notNull()
			.references(() => users.id),
		beneficiaryUserId: text("beneficiary_user_id").references(() => users.id),
		/** sha256 of the one-time accept token; null once accepted. */
		linkHash: text("link_hash"),
		linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
		proposedAt: timestamp("proposed_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		acceptedAt: timestamp("accepted_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("payout_beneficiaries_one_live_per_earner")
			.on(table.earnerUserId)
			.where(sql`${table.revokedAt} IS NULL`),
		uniqueIndex("payout_beneficiaries_link_hash_unique").on(table.linkHash),
		index("payout_beneficiaries_beneficiary_idx").on(table.beneficiaryUserId),
		check(
			"payout_beneficiaries_no_self_benefit",
			sql`${table.beneficiaryUserId} IS NULL OR ${table.beneficiaryUserId} <> ${table.earnerUserId}`,
		),
		check(
			"payout_beneficiaries_accepted_shape",
			sql`(${table.acceptedAt} IS NULL) = (${table.beneficiaryUserId} IS NULL)`,
		),
	],
).enableRLS();
