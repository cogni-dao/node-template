// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Finite UI refusals. No arbitrary server text escapes this transport boundary. */
export type ReviewRefusalCategory =
  | "unauthenticated"
  | "forbidden"
  | "epoch_not_review"
  | "locked_claimants_missing"
  | "invalid_input"
  | "unknown_subject"
  | "not_found"
  | "throttled"
  | "unavailable"
  | "outcome_unknown"
  | "unexpected"
  | "conflict";
export type ReviewStage = "read" | "save" | "reset";
const messages: Record<ReviewRefusalCategory, string> = {
  unauthenticated: "Sign in through this node, then refresh current values.",
  forbidden: "View only. You do not have access to change this review.",
  epoch_not_review: "This epoch has left review. Refresh review state.",
  locked_claimants_missing:
    "The required locked review snapshot is missing. Refresh review state; an approver must resolve this prerequisite.",
  invalid_input:
    "The value or format was refused. Correct the input before saving.",
  unknown_subject:
    "This contribution is absent from the locked review. Refresh review state.",
  not_found:
    "This epoch is unavailable in the current scope. Refresh review state.",
  throttled: "Too many requests. Wait before retrying.",
  unavailable: "The service could not confirm current values. Retry refresh.",
  outcome_unknown:
    "The write result is unknown. Refresh current values before another write.",
  unexpected: "Safe details are unavailable. Refresh review state.",
  conflict:
    "Current server values differ from the submitted change. Review them before another write.",
};
export class ReviewRefusal extends Error {
  constructor(
    readonly category: ReviewRefusalCategory,
    readonly stage: ReviewStage,
    readonly status: number | null = null,
    readonly retryAt: number | null = null,
  ) {
    super(messages[category]);
    this.name = "ReviewRefusal";
  }
}
export function safeReviewError(error: unknown, stage: ReviewStage) {
  return error instanceof ReviewRefusal
    ? error
    : error instanceof SyntaxError
      ? new ReviewRefusal("unexpected", stage)
      : new ReviewRefusal(
          stage === "read" ? "unavailable" : "outcome_unknown",
          stage,
        );
}
/** Inspect at most 2 KiB, including malformed/HTML responses; retain no body. */
async function literalError(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const timeout = setTimeout(() => {
    void reader.cancel().catch(() => undefined);
  }, 1000);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
      ? body.error
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => undefined);
  }
}
export async function reviewResponseError(
  response: Response,
  stage: ReviewStage,
) {
  const status = response.status;
  let category: ReviewRefusalCategory = "unexpected";
  let retryAt: number | null = null;
  if (status === 401) category = "unauthenticated";
  else if (status === 403) category = "forbidden";
  else if (status === 404) category = "not_found";
  else if (status === 429) {
    category = "throttled";
    const header = response.headers.get("Retry-After");
    const seconds = header && /^\d+$/.test(header) ? Number(header) : null;
    const date = header ? Date.parse(header) : NaN;
    const delay =
      seconds !== null
        ? seconds * 1000
        : Number.isFinite(date)
          ? date - Date.now()
          : 30_000;
    retryAt = Date.now() + Math.max(1000, Math.min(300_000, delay));
  } else if (status >= 500)
    category = stage === "read" ? "unavailable" : "outcome_unknown";
  else if (status === 400 || status === 422) {
    const literal = await literalError(response);
    category = literal?.startsWith("Unknown subject_ref: ")
      ? "unknown_subject"
      : "invalid_input";
  } else if (status === 409) {
    const literal = await literalError(response);
    if (literal === "Epoch must be in review status for overrides")
      category = "epoch_not_review";
    if (
      literal ===
      "No locked claimants found — epoch must have locked claimants before overrides"
    )
      category = "locked_claimants_missing";
  }
  if (response.body && !response.body.locked)
    void response.body.cancel().catch(() => undefined);
  return new ReviewRefusal(category, stage, status, retryAt);
}
