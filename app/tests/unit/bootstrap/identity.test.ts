// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/identity`
 * Purpose: Unit tests for importAttestedGithubBinding — idempotency, NO_AUTO_MERGE,
 *   and operator_attestation evidence (task.5024).
 * Scope: Mocked service DB + createBinding. Does not test real database interactions.
 * Invariants:
 *   - same-user existing binding → already_bound (no createBinding call)
 *   - foreign-user existing binding → already_linked (no writes)
 *   - new binding → created via createBinding with operator_attestation evidence
 *   - lost insert race against a foreign bind → already_linked
 * Side-effects: none
 * Links: src/bootstrap/identity.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));
const mockCreateBinding = vi.fn();

vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
	getServiceDb: () => ({
		query: { userBindings: { findFirst: mockFindFirst } },
		update: mockUpdate,
	}),
}));

vi.mock("@/adapters/server/identity/create-binding", () => ({
	createBinding: (...args: unknown[]) => mockCreateBinding(...args),
}));

// Import after mocks
import { importAttestedGithubBinding } from "@/bootstrap/identity";

const PARAMS = {
	userId: "user-1",
	githubId: "12345",
	githubLogin: "octocat",
	issuer: "https://hub.test.example",
	jti: "jti-abc",
	iat: 1_700_000_000,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("importAttestedGithubBinding", () => {
	it("returns already_bound and refreshes provider_login for a same-user binding", async () => {
		mockFindFirst.mockResolvedValue({ id: "b1", userId: "user-1" });

		const result = await importAttestedGithubBinding(PARAMS);

		expect(result).toBe("already_bound");
		expect(mockCreateBinding).not.toHaveBeenCalled();
		expect(mockSet).toHaveBeenCalledWith({ providerLogin: "octocat" });
	});

	it("returns already_linked for a binding owned by a different user (NO_AUTO_MERGE)", async () => {
		mockFindFirst.mockResolvedValue({ id: "b1", userId: "other-user" });

		const result = await importAttestedGithubBinding(PARAMS);

		expect(result).toBe("already_linked");
		expect(mockCreateBinding).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("creates a new binding with operator_attestation evidence", async () => {
		mockFindFirst
			.mockResolvedValueOnce(undefined) // pre-check: no binding
			.mockResolvedValueOnce({ id: "b2", userId: "user-1" }); // post-insert read

		const result = await importAttestedGithubBinding(PARAMS);

		expect(result).toBe("created");
		expect(mockCreateBinding).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			"github",
			"12345",
			{
				method: "operator_attestation",
				issuer: "https://hub.test.example",
				jti: "jti-abc",
				login: "octocat",
				iat: 1_700_000_000,
			},
		);
		expect(mockSet).toHaveBeenCalledWith({ providerLogin: "octocat" });
	});

	it("returns already_linked when the insert race is lost to a foreign bind", async () => {
		mockFindFirst
			.mockResolvedValueOnce(undefined) // pre-check: no binding
			.mockResolvedValueOnce({ id: "b3", userId: "other-user" }); // conflict winner

		const result = await importAttestedGithubBinding(PARAMS);

		expect(result).toBe("already_linked");
		expect(mockUpdate).not.toHaveBeenCalled();
	});
});
