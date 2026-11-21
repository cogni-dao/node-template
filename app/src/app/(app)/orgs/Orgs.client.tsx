// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/orgs/Orgs.client`
 * Purpose: Client mounts of the shared org sections (`OrgsSection` for `/orgs`, `OrgSection` for `/orgs/[id]`) with this node's endpoints and router link.
 * Scope: Mount only. It decides nothing: the routes decide every right.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY.
 * Side-effects: IO (the sections' fetches)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @internal
 */

"use client";

import { OrgSection, OrgsSection } from "@cogni/knowledge-base-ui";
import Link from "next/link";
import type { ReactElement } from "react";

import { formatCreditsAsDollars } from "@/features/payments/public";

import { ORG_ENDPOINTS } from "./org-endpoints";

/** Money reads as dollars through the payments feature's one formatter (the credits page uses the same). */
const formatMoney = (credits: number): string => `$${formatCreditsAsDollars(credits)}`;

export function OrgsClient(): ReactElement {
  return <OrgsSection endpoints={ORG_ENDPOINTS} formatMoney={formatMoney} LinkComponent={Link} />;
}

export function OrgClient({ orgId }: { readonly orgId: string }): ReactElement {
  return <OrgSection endpoints={ORG_ENDPOINTS} orgId={orgId} formatMoney={formatMoney} />;
}
