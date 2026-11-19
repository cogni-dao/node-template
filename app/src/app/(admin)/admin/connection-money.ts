// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connection-money`
 * Purpose: The node's credits-to-dollars conversion for the shared connections tables, from the payments module that owns the rate (the same one the Credits page uses).
 * Scope: Pure. Dollars are rounded to whole cents before they become credits.
 * Side-effects: none
 * Links: story.0038
 * @internal
 */

import type { Money } from "@cogni/knowledge-base-ui";

import { creditsToUsd, usdCentsToCredits } from "@/features/payments/public";

export const CONNECTION_MONEY: Money = {
	format: (credits) =>
		`$${creditsToUsd(credits).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
	toCredits: (dollars) => {
		const cents = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
		return cents >= 1 ? Number(usdCentsToCredits(cents)) : null;
	},
};
