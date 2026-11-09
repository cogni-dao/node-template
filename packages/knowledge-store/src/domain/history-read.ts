// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/history-read`
 * Purpose: Framework-agnostic read of one knowledge entry's history for a node route (story.0023).
 * Scope: Takes a structural port, returns `{ status, body, log }`. Imports no web framework, auth, container or logger.
 * Invariants:
 *   - NEVER_THROWS: every failure becomes a 503 `history_unavailable`; a missing entry is a 404.
 *   - ONE_TERMINAL_LOG: `log` carries counts and codes only, never values; the route emits it once.
 *   - Event name is `knowledge.history_read`.
 * Side-effects: IO (port reads through the injected port)
 * Links: hub change-history-design, change-history-fleet-adoption
 * @public
 */

import { knowledgeHistoryOperation } from "../contracts.js";
import type { KnowledgeHistoryEntry } from "./history.js";

/** The slice of a knowledge-store port the handler reads. */
export interface KnowledgeHistoryPort {
  knowledgeExists(id: string): Promise<boolean>;
  history?(id: string): Promise<readonly KnowledgeHistoryEntry[]>;
}

export interface KnowledgeHistoryReadLog {
  readonly event: "knowledge.history_read";
  readonly status: 200 | 404 | 503;
  readonly outcome: "success" | "error";
  readonly versionCount?: number;
  readonly reasonCount?: number;
  readonly errorCode?: "not_found" | "history_unavailable";
  /** Set on a failed read so the route may warn with the error class. */
  readonly errorName?: string;
}

export interface KnowledgeHistoryResult {
  readonly status: 200 | 404 | 503;
  readonly body: unknown;
  readonly log: KnowledgeHistoryReadLog;
}

const EVENT = "knowledge.history_read" as const;

const unavailable = (errorName?: string): KnowledgeHistoryResult => ({
  status: 503,
  body: { error: "history_unavailable" },
  log: {
    event: EVENT,
    status: 503,
    outcome: "error",
    errorCode: "history_unavailable",
    ...(errorName !== undefined && { errorName }),
  },
});

export async function readKnowledgeHistory(
  port: KnowledgeHistoryPort | null | undefined,
  id: string
): Promise<KnowledgeHistoryResult> {
  if (!port?.history) return unavailable();
  try {
    if (!(await port.knowledgeExists(id))) {
      return {
        status: 404,
        body: { error: "not found" },
        log: {
          event: EVENT,
          status: 404,
          outcome: "error",
          errorCode: "not_found",
        },
      };
    }
    const items = await port.history(id);
    const body = knowledgeHistoryOperation.output.parse({ items });
    return {
      status: 200,
      body,
      log: {
        event: EVENT,
        status: 200,
        outcome: "success",
        versionCount: items.length,
        reasonCount: items.filter((v) => v.reason !== null).length,
      },
    };
  } catch (error) {
    return unavailable((error as Error)?.name);
  }
}
