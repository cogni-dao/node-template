// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/profile/ai/requests/[id]/page`
 * Purpose: The unique approval page of one ask by an AI the signed-in person owns (`/profile/ai/requests/<id>`). An AI hands this link to its owner.
 * Scope: Server shell. The (app) layout requires a session; the data route re-checks that the request is this person's. Opening the page approves nothing.
 * Invariants: APPROVER_FOLLOWS_RESOURCE (the owner of the AI, on their profile); HUMAN_ROUTES_SESSION_ONLY.
 * Side-effects: none
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { RequestApproval } from "./RequestApproval.client";

export const dynamic = "force-dynamic";

export default async function OwnerRequestPage({ params }: { params: Promise<{ id: string }> }): Promise<ReactElement> {
  const { id } = await params;
  return (
    <PageContainer maxWidth="2xl">
      <RequestApproval requestId={id} />
    </PageContainer>
  );
}
