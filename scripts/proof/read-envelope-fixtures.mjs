// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Raw backend-port rows, before any shared serializer or node capability.
export const workRow = {
  id: "task.0015", type: "task", title: "Inheritance proof", status: "needs_implement",
  node: "shared", actor: "either", revision: 17, deployVerified: false,
  labels: ["proof"], specRefs: ["https://example.test/spec"], externalRefs: [{ system: "github", kind: "pr", externalId: "239" }],
  assignees: [{ kind: "user", userId: "u" }, { kind: "agent", agentId: "a" }, { kind: "system", serviceId: "s" }],
  summary: "s".repeat(700), outcome: "o".repeat(700), estimate: 3,
  scores: Object.fromEntries(Array.from({ length: 15 }, (_, n) => [`axis${n}`, { v: 3, ev: "é".repeat(400) }])),
  createdAt: "2026-10-28T01:02:03.000Z", updatedAt: "2026-10-29T01:02:03.000Z",
  sourceUrl: "https://forged.invalid/work", sourceUrlUnavailable: true,
};
export const knowledgeRow = {
  id: "probe-context", domain: "meta", title: "Recall trigger", content: "c".repeat(1700),
  sourceType: "agent", useWhen: "When proving future-field inheritance", entryType: "guide",
  sourceRef: "opaque-content-provenance", tags: ["proof"], entityId: null,
  confidencePct: 80, evaluateAt: new Date("2026-11-01T00:00:00.000Z"), resolutionStrategy: "manual",
  createdAt: new Date("2026-10-29T01:02:03.000Z"),
  sourceUrl: "https://forged.invalid/knowledge", sourceUrlUnavailable: true,
};
