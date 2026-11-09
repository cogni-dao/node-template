// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Typed Browse/Overview input errors. Crypto-free: safe in the root barrel's client graph. */

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
