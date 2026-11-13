// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { evaluateValidation, evaluateConfirmedMerge, evaluateDeliveryDestination } from "../src/delivery-evidence.js";

const head = "a".repeat(40);
const submission = { id: "s1", itemId: "task.1", pr: "https://github.com/a/b/pull/1", head, contributorPrincipalIds: ["author"] };
const proof = { id: "p1", submissionId: "s1", admittedAt: "2026-11-10T23:59:00Z", validatorPrincipalId: "validator", commentId: 1, bodyDigest: "b".repeat(64), rows: [{ human: "pass", ai: "na", loki: "pass", trace: "na", overall: "PASS" }], evidenceRefs: ["https://example.com/evidence"] } as const;
const receipt = { gateId: "g1", itemId: "task.1", pr: submission.pr, validatedHead: head, submissionIds: ["s1"], proofId: "p1", reviewRequestId: "review1", review: "pass", ci: [{ name: "build", verdict: "pass" }], release: "pass", candidateReleaseId: "release1", releaseSourceSha: head, checkedAt: "2026-11-10T23:59:30Z", mergeCommitSha: "c".repeat(40), mergedAt: "2026-11-11T00:00:00Z", confirmedAt: "2026-11-11T00:00:01Z" } as const;

describe("delivery evidence", () => {
  it("requires independent authenticated validation at the submitted head", () => {
    expect(evaluateValidation(submission, proof, head)).toBe(true);
    expect(evaluateValidation(submission, { ...proof, validatorPrincipalId: "author" }, head)).toBe(false);
    expect(evaluateValidation({ ...submission, contributorPrincipalIds: [] }, proof, head)).toBe(false);
    expect(evaluateValidation(submission, proof, "d".repeat(40))).toBe(false);
    expect(evaluateValidation(submission, { ...proof, rows: [{ human: "na", ai: "na", loki: "na", trace: "na", overall: "PASS" }] }, head)).toBe(false);
    expect(evaluateValidation(submission, { ...proof, rows: [{ ...proof.rows[0], loki: "unscorable" }] }, head)).toBe(false);
    for (const overall of ["FAIL", "DRIFT", "INDIRECT", "UNPROVEN"] as const) {
      expect(evaluateValidation(submission, { ...proof, rows: [{ ...proof.rows[0], overall }] }, head)).toBe(false);
    }
  });
  it("fails closed on missing proof and missing confirmed merge", () => {
    const input = { destination: "needs_closeout" as const, itemId: "task.1", pr: submission.pr, currentHead: head, submission, proof };
    expect(evaluateDeliveryDestination(input)).toBe(true);
    expect(evaluateDeliveryDestination({ ...input, proof: undefined })).toBe(false);
    expect(evaluateDeliveryDestination({ ...input, currentHead: "d".repeat(40) })).toBe(false);
    expect(evaluateDeliveryDestination({ ...input, destination: "done" })).toBe(false);
    expect(evaluateDeliveryDestination({ ...input, destination: "done", receipt })).toBe(true);
    expect(evaluateDeliveryDestination({ ...input, itemId: "task.2" })).toBe(false);
  });
  it("counts only a confirmed receipt bound to the proof and validated head", () => {
    expect(evaluateConfirmedMerge(submission, proof, receipt)).toBe(true);
    expect(evaluateConfirmedMerge(submission, proof, { ...receipt, ci: [{ name: "build", verdict: "fail" }] })).toBe(false);
    expect(evaluateConfirmedMerge(submission, proof, { ...receipt, proofId: "other" })).toBe(false);
    expect(evaluateConfirmedMerge(submission, proof, { ...receipt, submissionIds: ["s1", "unknown"] })).toBe(false);
    expect(evaluateConfirmedMerge(submission, proof, { ...receipt, releaseSourceSha: "d".repeat(40) })).toBe(false);
    expect(evaluateConfirmedMerge(submission, proof, { ...receipt, mergeCommitSha: "" })).toBe(false);
    expect(evaluateConfirmedMerge(submission, proof, { ...receipt, reviewRequestId: "" })).toBe(false);
    expect(evaluateConfirmedMerge(submission, proof, { ...receipt, ci: [] })).toBe(false);
    expect(evaluateConfirmedMerge(submission, proof, { ...receipt, mergedAt: "2026-11-10T23:00:00Z" })).toBe(false);
  });
});
