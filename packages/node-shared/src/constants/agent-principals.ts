// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/constants/agent-principals`
 * Purpose: The seeded internal agent principals (catalog slug -> user id), re-exported from `@cogni-dao/agent-grants`, their one home (task.0175).
 * Scope: Re-export only.
 * Side-effects: none
 * Links: packages/agent-grants/src/internal-principals.ts
 * @public
 */

export {
  NODE_AI_PRINCIPAL_SLUG,
  NODE_AI_PRINCIPAL_USER_ID,
  PRIORITIZER_PRINCIPAL_SLUG,
  PRIORITIZER_PRINCIPAL_USER_ID,
} from "@cogni/agent-grants";
