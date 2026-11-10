// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.credentials-renew.v1`
 * Purpose: Zod contract for POST /api/v1/agent/credentials/renew-v1 (task.0069, child of task.5474).
 * Scope: Output only: the request has no body. The caller's own v1 key is the input.
 * Invariants: CONTRACTS_ARE_TRUTH — single source for the renew wire shape. `userId` always equals the old key's `sub`.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5474
 * @public
 */

import { z } from "zod";

export const renewAgentCredentialsV1Operation = {
  id: "agent.credentials.renew_v1",
  output: z.object({
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    expiresAt: z.string().min(1),
    legacy: z.literal(true),
    hardStop: z.string().min(1),
  }),
} as const;
