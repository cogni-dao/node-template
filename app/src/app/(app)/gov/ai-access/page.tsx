// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/gov/ai-access/page`
 * Purpose: Server entrypoint for the node-wide AI permission approvals within governance.
 * Scope: Server component only; delegates to AiAccessView. Does not perform data fetching or add authority logic.
 * Invariants: Auth enforced by (app) layout guard; admin-only content gated by the shared section (NON_ADMIN_SEES_NOTHING) and by the roles route (403).
 * Side-effects: none (server render only)
 * Links: task.0114, src/app/api/v1/agent-access/roles/route.ts
 * @public
 */

import type { ReactElement } from "react";

import { AiAccessView } from "./view";

export default function AiAccessPage(): ReactElement {
  return <AiAccessView />;
}
