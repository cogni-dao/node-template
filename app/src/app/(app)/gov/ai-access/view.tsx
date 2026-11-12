// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/gov/ai-access/view`
 * Purpose: Helps a DAO admin decide which AI permissions the whole node grants.
 * Scope: Renders the shared AgentAccessSection with the human-plane endpoint. Does not decide who is an admin.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING (the section renders nothing unless the roles route confirms canManage).
 * Side-effects: IO (via the shared section's fetches to the roles route)
 * Links: task.0114
 * @internal
 */

"use client";

import { AgentAccessSection } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { AGENT_ACCESS_ENDPOINTS } from "./agent-access-endpoints";

export function AiAccessView(): ReactElement {
  return (
    <PageContainer maxWidth="2xl">
      <p className="max-w-prose text-muted-foreground">
        Permissions you approve here apply to the whole node.
      </p>
      <AgentAccessSection endpoints={AGENT_ACCESS_ENDPOINTS} />
    </PageContainer>
  );
}
