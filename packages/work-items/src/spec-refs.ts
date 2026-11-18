// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/spec-refs`
 * Purpose: The one type of a written `specRefs` entry: `knowledge:<atom-id>`, a design atom in this node's hub (story.0069).
 * Scope: Schema, pattern and parser. No I/O; whether the atom exists or is merged is the KPI's question, not the write's.
 * Invariants:
 *   - ONE_SPEC_REF_TYPE: create and PATCH take `SpecRefsInputSchema`; no second copy of the pattern.
 *   - READS_STAY_OPEN: the read DTO keeps `string[]`, so rows written before the type still read.
 *   - ID_IS_A_CITE_ID: the atom id follows `CITE_ID_PATTERN`, the id rule `cites` already uses.
 * Side-effects: none
 * Links: hub work-item-design-links, record-homes
 * @public
 */

import { z } from "zod";

import { CITE_ID_PATTERN } from "./cites.js";

export const SPEC_REF_PREFIX = "knowledge:";

export const SPEC_REF_MESSAGE =
  "specRefs entries are knowledge:<atom-id>, the design atoms this item is built against. A PR goes in pr; atoms you only read go in cites.";

/** The atom id a typed entry names, or null for any other form (an old URL, a bare id). */
export function parseSpecRef(ref: string): string | null {
  if (!ref.startsWith(SPEC_REF_PREFIX)) return null;
  const id = ref.slice(SPEC_REF_PREFIX.length);
  return CITE_ID_PATTERN.test(id) ? id : null;
}

export const SpecRefsInputSchema = z
  .array(
    z.string().refine((ref) => parseSpecRef(ref) !== null, {
      message: SPEC_REF_MESSAGE,
    }),
  )
  .describe(
    "Design atoms this item is built against, each knowledge:<atom-id> in this node's hub: its own design, the subsystem design it changes, or its parent's. On a patch it replaces the whole list.",
  );
