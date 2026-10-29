// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tool-envelope`
 * Purpose: One reusable, registry-level conformance audit so every agent tool
 *   inherits its API's stable context envelope by construction — the enforcement
 *   half of the `agent-tool-context-envelope` standard. Shared across nodes: each
 *   node calls `auditToolEnvelopes` over its own catalog in one test; a new tool
 *   or a new wire-DTO field then fails loudly instead of silently drifting.
 * Scope: Pure, schema-agnostic key-set logic. No zod, no I/O. Callers extract the
 *   tool's output-item key-set and the wire DTO key-set (they live in different
 *   packages / zod majors) and pass them in as data — the comparison never needs
 *   a live schema instance, so it is major-agnostic. This audit checks field
 *   PRESENCE only; per-field TYPE parity (a retyped field) is a complementary
 *   per-surface compile check the caller adds (e.g. `satisfies Pick<WireDto, …>`).
 * Invariants:
 *   - TOTAL_CLASSIFICATION: every catalog tool is either env-mapped or allowlisted.
 *   - NO_NEW_DRIFT: a wire field a mapped tool neither carries nor excludes fails.
 *   - LEDGER_FORCED_OUT: a `knownMissing` field the tool now carries fails as stale,
 *     so the ledger cannot silently retain settled debt. (It does NOT prevent a new
 *     `knownMissing` entry being added — that is gated by human diff review.)
 *   - CLEAN_SPEC: `excluded`/`knownMissing` must name real wire fields (typos fail).
 * Side-effects: none (pure)
 * Links: knowledge entry `agent-tool-context-envelope`
 * @public
 */

/** One tool's envelope contract against its authoritative wire DTO. */
export interface ToolEnvelopeSpec {
  /** Catalog tool id, e.g. `core__work_item_query`. */
  readonly toolId: string;
  /** Keys the tool actually emits per output item. */
  readonly toolItemKeys: readonly string[];
  /** Keys of the authoritative wire DTO the tool must mirror. */
  readonly wireKeys: readonly string[];
  /**
   * Wire fields a planner deliberately never needs (routing/attribution/lifecycle).
   * Each entry is a reviewed decision, visible in the diff.
   */
  readonly excluded?: readonly string[];
  /**
   * TRANSITIONAL ledger: wire fields this tool does not yet carry, with a tracked
   * follow-up to carry them. New drift outside this set fails; a `knownMissing`
   * field the tool starts carrying fails as stale so the ledger only shrinks.
   */
  readonly knownMissing?: readonly string[];
}

export interface EnvelopeViolation {
  readonly toolId: string;
  /** Wire fields neither carried, excluded, nor tracked — a silent drift. */
  readonly missing: readonly string[];
}

export interface StaleKnownMissing {
  readonly toolId: string;
  /** `knownMissing` fields the tool now carries → remove them from the ledger. */
  readonly fields: readonly string[];
}

export interface ToolEnvelopeAudit {
  /** Catalog tools with neither a spec nor an allowlist entry. */
  readonly unclassified: readonly string[];
  /** Spec/allowlist ids absent from the catalog (stale registrations). */
  readonly unknownIds: readonly string[];
  /** Mapped tools dropping a wire field not excluded or tracked. */
  readonly violations: readonly EnvelopeViolation[];
  /** Tracked-missing fields a tool now carries (ledger must shrink). */
  readonly staleKnownMissing: readonly StaleKnownMissing[];
  /** `excluded`/`knownMissing` entries that are not real wire fields (typos/rot). */
  readonly unknownSpecKeys: readonly { toolId: string; keys: readonly string[] }[];
}

/** True when nothing is unclassified, unknown, drifting, stale, or mis-keyed. */
export function isEnvelopeAuditClean(audit: ToolEnvelopeAudit): boolean {
  return (
    audit.unclassified.length === 0 &&
    audit.unknownIds.length === 0 &&
    audit.violations.length === 0 &&
    audit.staleKnownMissing.length === 0 &&
    audit.unknownSpecKeys.length === 0
  );
}

/**
 * Audit a tool catalog against its wire DTOs. `allToolIds` is the live catalog
 * (e.g. `getToolIds()`); `specs` maps envelope-bearing tools to their wire DTO;
 * `noEnvelopeTools` lists tools that surface no wire-DTO item envelope. A new tool
 * missing from both, or a new wire field, surfaces here — enforcement is by the
 * construction of the iteration, not a per-tool test.
 */
export function auditToolEnvelopes(args: {
  readonly allToolIds: readonly string[];
  readonly specs: readonly ToolEnvelopeSpec[];
  readonly noEnvelopeTools: readonly string[];
}): ToolEnvelopeAudit {
  const { allToolIds, specs, noEnvelopeTools } = args;
  const catalog = new Set(allToolIds);
  const classified = new Set<string>([
    ...specs.map((s) => s.toolId),
    ...noEnvelopeTools,
  ]);

  const unclassified = allToolIds.filter((id) => !classified.has(id));
  const unknownIds = [...classified].filter((id) => !catalog.has(id)).sort();

  const violations: EnvelopeViolation[] = [];
  const staleKnownMissing: StaleKnownMissing[] = [];
  const unknownSpecKeys: { toolId: string; keys: readonly string[] }[] = [];

  for (const spec of specs) {
    const carried = new Set(spec.toolItemKeys);
    const wire = new Set(spec.wireKeys);
    const excluded = new Set(spec.excluded ?? []);
    const known = new Set(spec.knownMissing ?? []);

    const missing = spec.wireKeys.filter(
      (k) => !carried.has(k) && !excluded.has(k) && !known.has(k)
    );
    if (missing.length > 0) {
      violations.push({ toolId: spec.toolId, missing: missing.sort() });
    }

    const stale = [...known].filter((k) => carried.has(k)).sort();
    if (stale.length > 0) {
      staleKnownMissing.push({ toolId: spec.toolId, fields: stale });
    }

    // An excluded/known-missing key that is not a real wire field is a typo or a
    // field that left the DTO — surface it so the spec cannot rot unnoticed.
    const badKeys = [...excluded, ...known].filter((k) => !wire.has(k)).sort();
    if (badKeys.length > 0) {
      unknownSpecKeys.push({ toolId: spec.toolId, keys: badKeys });
    }
  }

  return { unclassified, unknownIds, violations, staleKnownMissing, unknownSpecKeys };
}
