// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Pure delivery evidence contracts. Authentication and authoritative storage belong to the caller. */
import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const verdict = z.enum(["pass", "fail", "unscorable", "na"]);
const row = z.strictObject({
  human: verdict, ai: verdict, loki: verdict, trace: verdict,
  overall: z.enum(["PASS", "FAIL", "DRIFT", "INDIRECT", "UNPROVEN", "NA"]),
});
export const DeliverySubmissionSchema = z.strictObject({
  id: z.string().min(1), itemId: z.string().min(1), pr: z.url(), head: sha,
  contributorPrincipalIds: z.array(z.string().min(1)).min(1).max(50),
});
export const ValidationProofSchema = z.strictObject({
  id: z.string().min(1), submissionId: z.string().min(1),
  admittedAt: z.iso.datetime(), validatorPrincipalId: z.string().min(1), commentId: z.number().int().positive(),
  bodyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  rows: z.array(row).min(1).max(100), evidenceRefs: z.array(z.url()).min(1).max(100),
});
export const ConfirmedMergeReceiptSchema = z.strictObject({
  gateId: z.string().min(1), itemId: z.string().min(1), pr: z.url(), validatedHead: sha,
  submissionIds: z.array(z.string().min(1)).min(1).max(50), proofId: z.string().min(1),
  reviewRequestId: z.string().min(1), review: z.literal("pass"),
  ci: z.array(z.strictObject({ name: z.string().min(1), verdict: z.literal("pass") })).min(1).max(100),
  release: z.literal("pass"), candidateReleaseId: z.string().min(1),
  releaseSourceSha: sha, checkedAt: z.iso.datetime(), mergeCommitSha: sha,
  mergedAt: z.iso.datetime(), confirmedAt: z.iso.datetime(),
});

/** Returns false on incomplete, invalid or stale records. Inputs must come from authenticated stores. */
export function evaluateValidation(submissionValue: unknown, proofValue: unknown, currentHead: string): boolean {
  const submission = DeliverySubmissionSchema.safeParse(submissionValue);
  const proof = ValidationProofSchema.safeParse(proofValue);
  if (!submission.success || !proof.success || submission.data.head !== currentHead ||
      submission.data.id !== proof.data.submissionId ||
      submission.data.contributorPrincipalIds.includes(proof.data.validatorPrincipalId)) return false;
  return proof.data.rows.some((r) => [r.human, r.ai, r.loki, r.trace].includes("pass")) && proof.data.rows.every((r) =>
    r.overall === "PASS" && [r.human, r.ai, r.loki, r.trace].every((v) => v === "pass" || v === "na")
  );
}

/** A merged PR alone is not a passing receipt. The operator must authenticate the receipt writer. */
export function evaluateConfirmedMerge(submissionValue: unknown, proofValue: unknown, receiptValue: unknown): boolean {
  const submission = DeliverySubmissionSchema.safeParse(submissionValue);
  const proof = ValidationProofSchema.safeParse(proofValue);
  const receipt = ConfirmedMergeReceiptSchema.safeParse(receiptValue);
  if (!submission.success || !proof.success || !receipt.success) return false;
  const s = submission.data, p = proof.data, r = receipt.data;
  return evaluateValidation(s, p, r.validatedHead) && r.itemId === s.itemId && r.pr === s.pr &&
    r.proofId === p.id && r.submissionIds.includes(s.id) && r.releaseSourceSha === r.validatedHead &&
    Date.parse(p.admittedAt) <= Date.parse(r.checkedAt) && Date.parse(r.checkedAt) <= Date.parse(r.mergedAt) &&
    Date.parse(r.mergedAt) <= Date.parse(r.confirmedAt);
}

/**
 * Evaluate a protected destination using records supplied by the owning store.
 * This function does not authenticate records or read external state. Call it only
 * with records from an authorized immutable store and a current operator head.
 */
export function evaluateDeliveryDestination(input: {
  readonly destination: "needs_closeout" | "done";
  readonly itemId: string;
  readonly pr: string;
  readonly currentHead: string;
  readonly submission: unknown;
  readonly proof: unknown;
  readonly receipt?: unknown;
}): boolean {
  const submission = DeliverySubmissionSchema.safeParse(input.submission);
  if (!submission.success || submission.data.itemId !== input.itemId || submission.data.pr !== input.pr)
    return false;
  if (!evaluateValidation(submission.data, input.proof, input.currentHead)) return false;
  return input.destination === "needs_closeout" ||
    evaluateConfirmedMerge(submission.data, input.proof, input.receipt);
}
