// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/tool-envelope`
 * Purpose: Unit-prove the shared envelope-conformance audit — the reusable
 *   mechanism every node depends on. Proves it bites: unclassified tools, new
 *   drift, stale registrations, and a shrinking known-missing ledger.
 * Side-effects: none
 * Links: src/tool-envelope.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  auditToolEnvelopes,
  isEnvelopeAuditClean,
  type ToolEnvelopeSpec,
} from "../src/tool-envelope";

const wire = ["id", "status", "createdAt", "node"]; // a toy wire DTO

describe("auditToolEnvelopes", () => {
  it("is clean when every tool is classified and carries its wire fields", () => {
    const specs: ToolEnvelopeSpec[] = [
      {
        toolId: "t.query",
        toolItemKeys: ["id", "status", "createdAt"],
        wireKeys: wire,
        excluded: ["node"],
      },
    ];
    const audit = auditToolEnvelopes({
      allToolIds: ["t.query", "t.action"],
      specs,
      noEnvelopeTools: ["t.action"],
    });
    expect(isEnvelopeAuditClean(audit)).toBe(true);
  });

  it("flags a NEW catalog tool that is neither mapped nor allowlisted", () => {
    const audit = auditToolEnvelopes({
      allToolIds: ["t.query", "t.brand_new"],
      specs: [
        { toolId: "t.query", toolItemKeys: wire, wireKeys: wire },
      ],
      noEnvelopeTools: [],
    });
    expect(audit.unclassified).toEqual(["t.brand_new"]);
    expect(isEnvelopeAuditClean(audit)).toBe(false);
  });

  it("flags a NEW wire field a mapped tool neither carries nor excludes/tracks", () => {
    const audit = auditToolEnvelopes({
      allToolIds: ["t.query"],
      specs: [
        {
          toolId: "t.query",
          toolItemKeys: ["id", "status"], // createdAt dropped, not excluded/known
          wireKeys: wire,
          excluded: ["node"],
        },
      ],
      noEnvelopeTools: [],
    });
    expect(audit.violations).toEqual([
      { toolId: "t.query", missing: ["createdAt"] },
    ]);
  });

  it("allows a tracked known-missing field (transitional) without a violation", () => {
    const audit = auditToolEnvelopes({
      allToolIds: ["t.query"],
      specs: [
        {
          toolId: "t.query",
          toolItemKeys: ["id", "status"],
          wireKeys: wire,
          excluded: ["node"],
          knownMissing: ["createdAt"],
        },
      ],
      noEnvelopeTools: [],
    });
    expect(audit.violations).toEqual([]);
    expect(audit.staleKnownMissing).toEqual([]);
  });

  it("forces the ledger to shrink: a known-missing field now carried is stale", () => {
    const audit = auditToolEnvelopes({
      allToolIds: ["t.query"],
      specs: [
        {
          toolId: "t.query",
          toolItemKeys: ["id", "status", "createdAt"], // now carried
          wireKeys: wire,
          excluded: ["node"],
          knownMissing: ["createdAt"], // but still listed → stale
        },
      ],
      noEnvelopeTools: [],
    });
    expect(audit.staleKnownMissing).toEqual([
      { toolId: "t.query", fields: ["createdAt"] },
    ]);
  });

  it("flags a spec whose excluded/known-missing key is not a real wire field", () => {
    const audit = auditToolEnvelopes({
      allToolIds: ["t.query"],
      specs: [
        {
          toolId: "t.query",
          toolItemKeys: wire,
          wireKeys: wire,
          excluded: ["typo_field"], // not in wireKeys
          knownMissing: ["also_bogus"], // not in wireKeys
        },
      ],
      noEnvelopeTools: [],
    });
    expect(audit.unknownSpecKeys).toEqual([
      { toolId: "t.query", keys: ["also_bogus", "typo_field"] },
    ]);
    expect(isEnvelopeAuditClean(audit)).toBe(false);
  });

  it("flags stale spec/allowlist ids absent from the catalog", () => {
    const audit = auditToolEnvelopes({
      allToolIds: ["t.query"],
      specs: [{ toolId: "t.query", toolItemKeys: wire, wireKeys: wire }],
      noEnvelopeTools: ["t.removed"],
    });
    expect(audit.unknownIds).toEqual(["t.removed"]);
  });
});
