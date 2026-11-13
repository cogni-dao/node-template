// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/ai-access/requests/[id]/page`
 * Purpose: The unique approval page of one ask a node-admin decides (`/admin/ai-access/requests/<id>`). An AI hands this link to its human.
 * Scope: Server shell. The `(admin)` layout refuses non-admins before this renders; the data route re-checks admin and that this request is one an admin may decide.
 * Invariants: ADMIN_ACTS_IN_ADMIN; APPROVER_FOLLOWS_RESOURCE; HUMAN_ROUTES_SESSION_ONLY.
 * Side-effects: none
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { RequestApproval } from "./RequestApproval.client";

export const dynamic = "force-dynamic";

export default async function AdminRequestPage({ params }: { params: Promise<{ id: string }> }): Promise<ReactElement> {
  const { id } = await params;
  return (
    <PageContainer maxWidth="2xl">
      <RequestApproval requestId={id} />
    </PageContainer>
  );
}
