// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/ai/execution-error-mapper`
 * Purpose: Map AiExecutionErrorCode to HTTP responses at the route edge.
 * Scope: Single canonical mapping from serialization-safe execution error codes to HTTP status/message.
 *   Used by both /api/v1/ai/chat and /v1/chat/completions route handlers.
 * Invariants:
 *   - AiExecutionError is the canonical cross-boundary error (Temporal+Redis → facade → route)
 *   - No fake port/feature error reconstruction — map codes directly to HTTP
 * Side-effects: none
 * Links: @cogni/ai-core/execution/error-codes, route handlers
 * @internal
 */

import type { ConnectionRefusal } from "@cogni/agent-grants";
import type { AiExecutionErrorCode } from "@cogni/ai-core";

// Chat route uses 402 (Payment Required) for insufficient credits.
// OpenAI-compat route uses 429 (Too Many Requests) per OpenAI API convention.
// This is intentional — each route follows its own API contract.
const HTTP_STATUS_MAP: Record<AiExecutionErrorCode, number> = {
  insufficient_credits: 402,
  rate_limit: 429,
  timeout: 408,
  aborted: 408,
  not_found: 404,
  invalid_request: 400,
  internal: 500,
  // Operator-fault (provider down / unfunded) → 503, never 500. Client maps 503
  // to a "temporarily unavailable" retry message, never "add credits" (bug.5056).
  provider_unavailable: 503,
};

const OPENAI_ERROR_MAP: Record<
  AiExecutionErrorCode,
  { status: number; message: string; type: string }
> = {
  insufficient_credits: {
    status: 429,
    message:
      "You exceeded your current quota. Please check your plan and billing details.",
    type: "insufficient_quota",
  },
  rate_limit: {
    status: 429,
    message: "Rate limit exceeded. Please retry after a brief wait.",
    type: "rate_limit_error",
  },
  timeout: {
    status: 408,
    message: "Request timed out.",
    type: "timeout_error",
  },
  aborted: {
    status: 408,
    message: "Request was cancelled.",
    type: "timeout_error",
  },
  not_found: {
    status: 404,
    message: "The model does not exist or you do not have access to it.",
    type: "invalid_request_error",
  },
  invalid_request: {
    status: 400,
    message: "Invalid request.",
    type: "invalid_request_error",
  },
  internal: {
    status: 500,
    message: "The server encountered an internal error. Please retry.",
    type: "server_error",
  },
  provider_unavailable: {
    status: 503,
    message:
      "The upstream AI provider is temporarily unavailable. Please retry shortly.",
    type: "service_unavailable",
  },
};

const OPENAI_FALLBACK = {
  status: 500,
  message: "The server encountered an internal error.",
  type: "server_error",
};

// Connect from home (story.0038): a run billed to a connected customer's record is refused with a plain code. An allowance that is spent or a cap that is reached is a payment
// problem (402); a Suspend or a Disconnect is a refusal of the account itself (403). Both name the code, never a balance.
const CONNECTION_REFUSAL_STATUS: Record<ConnectionRefusal, number> = {
  connection_cap_reached: 402,
  connection_allowance_empty: 402,
  connection_suspended: 403,
  connection_disconnected: 403,
};

/** HTTP status for a connection refusal on the chat route's JSON errors. */
export function connectionRefusalToHttpStatus(code: ConnectionRefusal): number {
  return CONNECTION_REFUSAL_STATUS[code] ?? 403;
}

/** OpenAI-compatible error fields for a connection refusal on the completions route; `code` is the plain refusal code. */
export function connectionRefusalToOpenAiError(code: ConnectionRefusal): { status: number; message: string; type: string; code: ConnectionRefusal } {
  return {
    status: connectionRefusalToHttpStatus(code),
    message: "This account cannot pay for the request right now.",
    type: "insufficient_quota",
    code,
  };
}

/**
 * Map execution error code to HTTP status for JSON error responses.
 * Used by /api/v1/ai/chat route.
 */
export function executionErrorToHttpStatus(code: AiExecutionErrorCode): number {
  return HTTP_STATUS_MAP[code] ?? 500;
}

/**
 * Map execution error code to OpenAI-compatible error response fields.
 * Used by /v1/chat/completions route (OpenAI API contract).
 */
export function executionErrorToOpenAiError(code: AiExecutionErrorCode): {
  status: number;
  message: string;
  type: string;
} {
  return OPENAI_ERROR_MAP[code] ?? OPENAI_FALLBACK;
}
