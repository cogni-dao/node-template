// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/goals-preview/page`
 * Purpose: Preview the real GoalsBoard on a production readings snapshot plus
 *   two labeled fixture KPIs (volume, slo), without signing in.
 * Scope: Fixture-only development route; the live Goals tab and its auth are unchanged.
 * Invariants: Production/test return 404; reads come from the seeded query cache only.
 * Side-effects: none
 * Links: features/goals/components/GoalsBoard.tsx, ./GoalsPreviewClient.client.tsx
 * @internal
 */
import { notFound } from "next/navigation";
import { PageContainer } from "@/components";
import { getEnv } from "@/shared/env";
import { GoalsPreviewClient } from "./GoalsPreviewClient.client";

export default function GoalsPreviewPage() {
  if (getEnv("NODE_ENV") !== "development") notFound();
  return (
    <PageContainer maxWidth="2xl">
      <GoalsPreviewClient />
    </PageContainer>
  );
}
