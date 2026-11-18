// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared query identity, literal matching and exact consumed cursor policy. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  KNOWLEDGE_BROWSE_PAGE_SIZE,
  KNOWLEDGE_BROWSE_SEARCH_SCAN_MAX_ROWS,
  type KnowledgeBrowseQuery,
  KnowledgeBrowseQuerySchema,
  type KnowledgeSummary,
} from "../contracts.js";
import {
  KnowledgeBrowseCursorError,
  KnowledgeBrowseQueryError,
} from "./browse-errors.js";
import type { Knowledge } from "./schemas.js";

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
/** The six literal fields a browse search matches, case-insensitively. */
export function matchesBrowseFields(
  fields: readonly unknown[],
  needle: string
): boolean {
  return fields.some(
    (value) => typeof value === "string" && value.toLowerCase().includes(needle)
  );
}
export function matchesBrowse(row: Knowledge, needle: string): boolean {
  return matchesBrowseFields(
    [row.id, row.title, row.content, row.domain, row.entryType, row.entityId],
    needle
  );
}
/** Rows per search read; a broad search stops after its first page of matches. */
const SEARCH_BATCH_ROWS = 200;
/**
 * One search window: reads ordered candidate batches after the cursor until it
 * holds a page of matches plus proof of one more, runs out of candidates, or
 * examines `KNOWLEDGE_BROWSE_SEARCH_SCAN_MAX_ROWS`. `resumeAfter` is the row
 * the next window continues after: the last match when another follows, the
 * last examined row at the scan bound, absent when the candidates ran out.
 */
export async function scanBrowseSearch<T>(
  readBatch: (after: T | undefined, limit: number) => Promise<readonly T[]>,
  matches: (row: T) => boolean
): Promise<{ matches: T[]; scannedRows: number; resumeAfter?: T }> {
  const found: T[] = [];
  let scannedRows = 0;
  let after: T | undefined;
  while (scannedRows < KNOWLEDGE_BROWSE_SEARCH_SCAN_MAX_ROWS) {
    const limit = Math.min(
      SEARCH_BATCH_ROWS,
      KNOWLEDGE_BROWSE_SEARCH_SCAN_MAX_ROWS - scannedRows
    );
    const batch = await readBatch(after, limit);
    for (const row of batch) {
      if (matches(row)) {
        if (found.length === KNOWLEDGE_BROWSE_PAGE_SIZE)
          return { matches: found, scannedRows, resumeAfter: found.at(-1) };
        found.push(row);
      }
      scannedRows++;
    }
    if (batch.length < limit) return { matches: found, scannedRows };
    after = batch.at(-1);
  }
  return after === undefined
    ? { matches: found, scannedRows }
    : { matches: found, scannedRows, resumeAfter: after };
}
