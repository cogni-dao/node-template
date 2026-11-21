// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/orgs/[id]/page`
 * Purpose: `/orgs/[id]`: one org's balance, people and linked nodes.
 * Scope: Server component; auth is enforced by `proxy.ts` and the (app) layout. Renders the shared section only; the org route answers 404 to anyone not in the org.
 * Invariants: NON_DISCLOSING (an unknown org and an org the caller is not in read the same).
 * Side-effects: none (server render only)
 * Links: ../Orgs.client.tsx
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { OrgClient } from "../Orgs.client";

export default async function OrgPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<ReactElement> {
  const { id } = await params;
  return (
    <PageContainer maxWidth="2xl">
      <OrgClient orgId={id} />
    </PageContainer>
  );
}
