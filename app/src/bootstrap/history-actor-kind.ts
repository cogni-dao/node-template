// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/bootstrap/history-actor-kind`
 * Purpose: Work-item history names each version's actor kind through the one classifier (hub activity-attribution, task.0133).
 * Scope: Host composition. Wraps the store's `history` and `historyPage` reads; every other method passes through unchanged.
 * Invariants:
 *   - KIND_IS_NEVER_STORED: `actorKind` is read from the classifier when history is read; nothing writes it.
 *   - ONE_CLASSIFIER: the kind comes only from `agentAuthority.principalClass`, which is `classifyPrincipal` from `@cogni/agent-grants`.
 *   - ONE_HISTORY_SHAPE: the route, the item envelope and `core__work_item_read` read the same wrapped store, so they agree.
 *   - KIND_NEVER_BLOCKS_A_READ: a classifier failure leaves that actor's versions without `actorKind` and logs one warning; the read succeeds.
 *   - ONE_CALL_PER_ACTOR: each read classifies each distinct actor once.
 *   - EVERY_READ_IS_SEEN: each labelled read reports its version count and counts by kind (no ids), so a tool read is as visible in logs as a route read.
 *   - BOUNDED_WAIT: a classifier answer slower than CLASSIFY_TIMEOUT_MS counts as a failure, so a slow service database never stalls a history read.
 * Side-effects: IO (classifier reads through the caller's port)
 * Links: hub activity-attribution, change-history-design, @cogni/agent-grants classifyPrincipal
 * @public
 */

import { countActorKinds } from "@cogni/work-items";
import type {
  HistoryActorKind,
  HistoryEntry,
  HistoryPage,
  WorkItemHistoryStore,
} from "@cogni/work-items";

/** Answers what kind of actor a user id is. */
export type ClassifyActor = (userId: string) => Promise<HistoryActorKind>;

/** How long one classifier answer may take before the version is served without a kind. */
export const CLASSIFY_TIMEOUT_MS = 2_000;

class ClassifyTimeoutError extends Error {
  override name = "ClassifyTimeoutError";
}

function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClassifyTimeoutError(`classifier took over ${CLASSIFY_TIMEOUT_MS} ms`)), CLASSIFY_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Called once per labelled read with counts only: how many versions, and how many of each kind. */
export type HistoryLabelled = (counts: { versionCount: number; actorKinds: Record<string, number> }) => void;

/** Called once per actor the classifier could not answer for; ids are not logged. */
export type ClassifyFailed = (error: unknown) => void;

async function withKinds(
  entries: readonly HistoryEntry[],
  classify: ClassifyActor,
  onFailure: ClassifyFailed,
  onLabelled: HistoryLabelled
): Promise<HistoryEntry[]> {
  const actors = [...new Set(entries.map((entry) => entry.actor).filter((actor): actor is string => actor !== null))];
  const kinds = new Map<string, HistoryActorKind>();
  await Promise.all(
    actors.map(async (actor) => {
      try {
        kinds.set(actor, await withinDeadline(classify(actor)));
      } catch (error) {
        onFailure(error);
      }
    })
  );
  const labelled = entries.map((entry) => {
    const kind = entry.actor === null ? undefined : kinds.get(entry.actor);
    return kind === undefined ? entry : { ...entry, actorKind: kind };
  });
  onLabelled({ versionCount: labelled.length, actorKinds: countActorKinds(labelled) });
  return labelled;
}

/** The same store, with each history version carrying its actor's kind. */
export function withHistoryActorKinds<T extends Pick<WorkItemHistoryStore, "history" | "historyPage">>(
  store: T,
  classify: ClassifyActor,
  onFailure: ClassifyFailed,
  onLabelled: HistoryLabelled = () => {}
): T {
  const { history, historyPage } = store;
  return {
    ...store,
    ...(history
      ? {
          history: async (id: Parameters<NonNullable<WorkItemHistoryStore["history"]>>[0]) =>
            withKinds(await history.call(store, id), classify, onFailure, onLabelled),
        }
      : {}),
    ...(historyPage
      ? {
          historyPage: async (
            ...args: Parameters<NonNullable<WorkItemHistoryStore["historyPage"]>>
          ): Promise<HistoryPage> => {
            const page = await historyPage.apply(store, args);
            return { ...page, entries: await withKinds(page.entries, classify, onFailure, onLabelled) };
          },
        }
      : {}),
  };
}
