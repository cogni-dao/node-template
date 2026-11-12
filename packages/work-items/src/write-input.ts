// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/write-input`
 * Purpose: Turn a parsed create or patch request into the store input, once, for every node and tool (task.0097).
 * Scope: Pure functions. No I/O. The store validates every value; these only pick, brand and drop `undefined`.
 * Invariants:
 *   - PACKAGE_OWNS_THE_FIELD_LIST: a field the package adds to the store input reaches every node on the pin bump. `WORK_ITEM_CREATE_FIELDS` must name every key of `WorkItemsCreateInput`; a compile-time check fails when one is missing.
 *   - NODE_FIELDS_STOP_HERE: a key that only a node adds to its request schema is not forwarded.
 *   - PATCH_TOP_LEVEL_IS_FIXED: the patch builder forwards `id`, `expectedRevision`, `reason`, `cites` and `set`. The store owns the allowlist of `set` keys.
 *   - NO_UNDEFINED_KEYS: an absent value is an absent key, so the store sees what the caller sent.
 * Side-effects: none
 * Links: hub change-history-design ("Package entries a node calls")
 * @public
 */

import type { CiteRef } from "./cites.js";
import type { WorkItemsCreateInput, WorkItemsPatchInput, WorkItemsPatchSet } from "./content.js";
import { toWorkItemId } from "./types.js";

/** Every key of the store's create input. */
export const WORK_ITEM_CREATE_FIELDS = [
  "id",
  "type",
  "title",
  "summary",
  "outcome",
  "specRefs",
  "projectId",
  "parentId",
  "labels",
  "assignees",
  "node",
  "status",
  "priority",
  "rank",
  "estimate",
  "scores",
  "moves",
] as const satisfies readonly (keyof WorkItemsCreateInput)[];

type MissingCreateField = Exclude<
  keyof WorkItemsCreateInput,
  (typeof WORK_ITEM_CREATE_FIELDS)[number]
>;
// Compile-time exhaustiveness: this line fails to type-check when the store input gains a key the list lacks.
const CREATE_FIELDS_ARE_COMPLETE: [MissingCreateField] extends [never] ? true : never = true;
void CREATE_FIELDS_ARE_COMPLETE;

type Loose<T> = { [K in keyof T]?: T[K] | undefined };

const BRANDED_CREATE_IDS = ["id", "projectId", "parentId"] as const;

/** A parsed create request: the store input with its id fields as plain strings. */
export type WorkItemCreateWire = Loose<
  Omit<WorkItemsCreateInput, "id" | "projectId" | "parentId" | "type" | "title">
> & {
  readonly id?: string | undefined;
  readonly projectId?: string | undefined;
  readonly parentId?: string | undefined;
  readonly type: WorkItemsCreateInput["type"];
  readonly title: string;
};

/** A parsed patch request, from the HTTP route or an agent tool. */
export interface WorkItemPatchWire {
  readonly id: string;
  readonly expectedRevision?: number | undefined;
  readonly reason: string;
  readonly cites?: readonly CiteRef[] | undefined;
  readonly set: Loose<WorkItemsPatchSet>;
}

/** The store input for a create: listed fields only, ids branded, no `undefined` keys. */
export function toWorkItemsCreateInput(wire: WorkItemCreateWire): WorkItemsCreateInput {
  const source = wire as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const key of WORK_ITEM_CREATE_FIELDS) {
    const value = source[key];
    if (value === undefined) continue;
    out[key] =
      (BRANDED_CREATE_IDS as readonly string[]).includes(key) && typeof value === "string"
        ? toWorkItemId(value)
        : value;
  }
  return out as unknown as WorkItemsCreateInput;
}

/** The store input for a patch: fixed top-level keys, id branded, `set` without `undefined` keys. */
export function toWorkItemsPatchInput(wire: WorkItemPatchWire): WorkItemsPatchInput {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wire.set)) {
    if (value !== undefined) set[key] = value;
  }
  return {
    id: toWorkItemId(wire.id),
    ...(wire.expectedRevision !== undefined && { expectedRevision: wire.expectedRevision }),
    reason: wire.reason,
    ...(wire.cites !== undefined && { cites: wire.cites }),
    set: set as WorkItemsPatchSet,
  };
}
