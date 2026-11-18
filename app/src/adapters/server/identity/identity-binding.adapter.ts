// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Drizzle adapter for atomic identity nonce redemption and binding writes. */

import type { Database } from "@cogni/db-client";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { createBindingInTransaction } from "@/adapters/server/identity/create-binding";
import type {
	AttestedGithubBindingEvidence,
	IdentityBindingRepositoryPort,
	IdentityBindingTransactionPort,
} from "@/ports";
import { linkTransactions, userBindings } from "@/shared/db/schema";

type BindingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

class DrizzleIdentityBindingTransaction
	implements IdentityBindingTransactionPort
{
	constructor(private readonly tx: BindingTransaction) {}

	async consumeNonce(params: {
		nonce: string;
		userId: string;
		now: Date;
		provider?: "github" | "wallet";
	}): Promise<boolean> {
		const [consumed] = await this.tx
			.update(linkTransactions)
			.set({ consumedAt: params.now })
			.where(
				and(
					eq(linkTransactions.id, params.nonce),
					eq(linkTransactions.userId, params.userId),
					eq(linkTransactions.provider, params.provider ?? "github"),
					isNull(linkTransactions.consumedAt),
					gt(linkTransactions.expiresAt, params.now),
				),
			)
			.returning({ id: linkTransactions.id });
		return Boolean(consumed);
	}

	async findWalletBinding(address: string) {
		const [row] = await this.tx
			.select({ id: userBindings.id, userId: userBindings.userId })
			.from(userBindings)
			.where(
				and(
					eq(userBindings.provider, "wallet"),
					sql`lower(${userBindings.externalId}) = ${address.toLowerCase()}`,
				),
			)
			.limit(1);
		return row ?? null;
	}

	async createWalletBinding(params: {
		userId: string;
		address: string;
		evidence: Record<string, unknown>;
	}): Promise<boolean> {
		const result = await createBindingInTransaction(
			this.tx,
			params.userId,
			"wallet",
			params.address.toLowerCase(),
			{ method: "siwe_bind", ...params.evidence },
		);
		return result.created;
	}

	async findGithubBinding(githubId: string) {
		return (
			(await this.tx.query.userBindings.findFirst({
				where: and(
					eq(userBindings.provider, "github"),
					eq(userBindings.externalId, githubId),
				),
			})) ?? null
		);
	}

	async updateGithubLogin(
		bindingId: string,
		login: string | null,
	): Promise<void> {
		await this.tx
			.update(userBindings)
			.set({ providerLogin: login })
			.where(eq(userBindings.id, bindingId));
	}

	async createGithubBinding(params: {
		userId: string;
		githubId: string;
		evidence: AttestedGithubBindingEvidence;
	}): Promise<boolean> {
		const result = await createBindingInTransaction(
			this.tx,
			params.userId,
			"github",
			params.githubId,
			{
				method: "operator_attestation",
				...params.evidence,
			},
		);
		return result.created;
	}
}

export class DrizzleIdentityBindingRepository
	implements IdentityBindingRepositoryPort
{
	constructor(private readonly db: Database) {}

	async insertNonce(params: {
		nonce: string;
		userId: string;
		expiresAt: Date;
		provider?: "github" | "wallet";
	}): Promise<void> {
		await this.db.insert(linkTransactions).values({
			id: params.nonce,
			userId: params.userId,
			provider: params.provider ?? "github",
			expiresAt: params.expiresAt,
		});
	}

	transaction<T>(
		run: (tx: IdentityBindingTransactionPort) => Promise<T>,
	): Promise<T> {
		return this.db.transaction((tx) =>
			run(new DrizzleIdentityBindingTransaction(tx)),
		);
	}
}
