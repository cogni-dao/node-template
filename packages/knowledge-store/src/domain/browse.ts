// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared query identity, literal matching and exact consumed cursor policy. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type KnowledgeBrowseQuery,
  KnowledgeBrowseQuerySchema,
  type KnowledgeSummary,
} from "../contracts.js";
import type { Knowledge } from "./schemas.js";

/** The continuation cursor is malformed or belongs to another query; routes map to 400. */
export class KnowledgeBrowseCursorError extends Error {
  readonly code = "KNOWLEDGE_BROWSE_INVALID_CURSOR" as const;
  constructor(message = "Invalid browse cursor") {
    super(message);
    this.name = "KnowledgeBrowseCursorError";
  }
}

/** The browse query fails schema validation; routes map to 400. */
export class KnowledgeBrowseQueryError extends Error {
  readonly code = "KNOWLEDGE_BROWSE_INVALID_QUERY" as const;
  constructor(message = "Invalid browse query") {
    super(message);
    this.name = "KnowledgeBrowseQueryError";
  }
}

const cursorSchema = z
  .object({
    query: z.string(),
    id: z.string().min(1).max(1000),
    value: z.union([z.string(), z.number().int().min(-1).max(100)]),
  })
  .strict();
export function browseQuery(
  input: KnowledgeBrowseQuery,
  operation: "browse" | "overview" = "browse"
) {
  const parsedQuery = KnowledgeBrowseQuerySchema.safeParse(input);
  if (!parsedQuery.success) throw new KnowledgeBrowseQueryError();
  const { cursor, ...query } = parsedQuery.data;
  const signature = createHash("sha256")
    .update(JSON.stringify({ operation, ...query }))
    .digest("hex");
  let position: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try {
      position = cursorSchema.parse(JSON.parse(decodeURIComponent(cursor)));
    } catch {
      throw new KnowledgeBrowseCursorError("Invalid browse cursor");
    }
    if (position.query !== signature)
      throw new KnowledgeBrowseCursorError("Browse cursor does not match query");
    if (
      (query.sort === "confidencePct") !==
      (typeof position.value === "number")
    )
      throw new KnowledgeBrowseCursorError("Invalid browse cursor");
  }
  if (
    position &&
    query.sort === "createdAt" &&
    position.value !== "" &&
    (typeof position.value !== "string" ||
      !z.iso.datetime({ offset: true, local: true }).safeParse(position.value)
        .success)
  )
    throw new KnowledgeBrowseCursorError("Invalid browse cursor");
  if (
    position &&
    query.sort === "confidencePct" &&
    (Number(position.value) < -1 || Number(position.value) > 100)
  )
    throw new KnowledgeBrowseCursorError("Invalid browse cursor");

  return { query, signature, position };
}
export function sortValue(
  row: KnowledgeSummary,
  sort: ReturnType<typeof browseQuery>["query"]["sort"]
): string | number {
  if (sort === "confidencePct") return row.confidencePct ?? -1;
  return row[sort] ?? "";
}
export function nextBrowseCursor(
  signature: string,
  row: KnowledgeSummary,
  sort: ReturnType<typeof browseQuery>["query"]["sort"],
  value: string | number = sortValue(row, sort)
): string {
  return encodeURIComponent(
    JSON.stringify({
      query: signature,
      id: row.id,
      value,
    })
  );
}
export function summary(row: Knowledge): KnowledgeSummary {
  return {
    id: row.id,
    domain: row.domain,
    entityId: row.entityId ?? null,
    useWhen: row.useWhen ?? null,
    title: row.title,
    entryType: row.entryType ?? "finding",
    confidencePct: row.confidencePct ?? null,
    sourceType: row.sourceType,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}
export function matchesBrowse(row: Knowledge, needle: string): boolean {
  return [
    row.id,
    row.title,
    row.content,
    row.domain,
    row.entryType,
    row.entityId,
  ].some((value) => value?.toLowerCase().includes(needle));
}
