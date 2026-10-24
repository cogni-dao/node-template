// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Existing facade request HMAC, shared with its trusted receiver without normalization drift. */
import { createHmac } from "node:crypto";
import type { MessageDto } from "@/features/ai/public.server";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function completionRequestHash(
  input: {
    graphId: string;
    messages: MessageDto[];
    modelRef: import("@cogni/ai-core").ModelRef;
    stateKey?: string;
  },
  key: string
): string {
  return createHmac("sha256", key)
    .update("completion-request:v1\0", "utf8")
    .update(
      JSON.stringify(
        canonicalize({
          graphId: input.graphId,
          messages: input.messages,
          modelRef: input.modelRef,
          stateKey: input.stateKey ?? null,
        })
      ),
      "utf8"
    )
    .digest("hex");
}
