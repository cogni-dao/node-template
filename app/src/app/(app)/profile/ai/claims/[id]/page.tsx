// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/ai/claims/[id]/page`
 * Purpose: The page an existing AI's claim link opens (`/profile/ai/claims/<id>`): the signed-in person claims the AI with one click.
 * Scope: Server shell. The (app) layout requires a session. Opening the page claims nothing.
 * Invariants: OWNER_IS_THE_CLICKER; HUMAN_ROUTES_SESSION_ONLY.
 * Side-effects: none
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { Claim } from "./Claim.client";

export const dynamic = "force-dynamic";

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }): Promise<ReactElement> {
  const { id } = await params;
  return (
    <PageContainer maxWidth="2xl">
      <Claim claimId={id} />
    </PageContainer>
  );
}
