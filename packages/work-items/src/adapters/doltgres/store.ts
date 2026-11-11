// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/adapters/doltgres/store`
 * Purpose: The supported way for a node to build the Doltgres work-item store (task.0097).
 * Scope: One factory. It adds no behavior to the adapter; it makes the cite and moves wiring an explicit choice.
 * Invariants:
 *   - WIRING_IS_A_CHOICE: `entryResolver` and `metricBaseline` are required options. A port turns the capability on; `null` says this node serves none. A forgotten option is a type error at the version bump.
 *   - BASELINE_NEEDS_A_RESOLVER: a baseline port without a resolver cannot pin a move, so construction throws. A resolver without a baseline port is allowed: cites work, and a non-empty `moves` write is 400 `moves_unsupported`.
 *   - CONSTRUCTOR_STAYS_OPEN: `new DoltgresWorkItemAdapter(sql, options)` keeps its optional options for wrappers; only this factory checks the wiring.
 * Side-effects: none
 * Links: hub change-history-design ("Package entries a node calls")
 * @public
 */

import type { Sql } from "postgres";

import type { EntryResolver } from "../../cites.js";
import type { MetricBaselinePort } from "../../moves.js";
import {
  DoltgresWorkItemAdapter,
  type DoltgresWorkItemAdapterOptions,
} from "./adapter.js";

export interface DoltgresWorkItemStoreOptions
  extends Omit<DoltgresWorkItemAdapterOptions, "entryResolver" | "metricBaseline"> {
  /**
   * Pins a patch's `cites` and a create or patch's new `moves` ids to commits. Build it with
   * `createDoltgresEntryResolver` from `@cogni-dao/knowledge-store` on a pool that is not the writer's.
   * `null`: this node serves no cites; a cited patch is 400 `cites_unsupported`.
   */
  readonly entryResolver: EntryResolver | null;
  /**
   * Reads a metric's latest good observation id when a move first appears.
   * `null`: this node serves no moves; a non-empty `moves` write is 400 `moves_unsupported`.
   */
  readonly metricBaseline: MetricBaselinePort | null;
}

export function createDoltgresWorkItemStore(
  sql: Sql,
  options: DoltgresWorkItemStoreOptions,
): DoltgresWorkItemAdapter {
  const { entryResolver, metricBaseline, ...rest } = options;
  // The type already demands both; this catches a cast or a plain-JS caller at boot, not on the first write.
  if (entryResolver === undefined || metricBaseline === undefined) {
    throw new TypeError(
      "createDoltgresWorkItemStore: pass entryResolver and metricBaseline, each a port or null",
    );
  }
  if (metricBaseline && !entryResolver) {
    throw new TypeError(
      "createDoltgresWorkItemStore: metricBaseline needs an entryResolver; a move cannot be pinned without one",
    );
  }
  return new DoltgresWorkItemAdapter(sql, {
    ...rest,
    ...(entryResolver && { entryResolver }),
    ...(metricBaseline && { metricBaseline }),
  });
}
