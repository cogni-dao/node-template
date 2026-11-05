// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/RelativeTime`
 * Purpose: Human-friendly timestamp rendering for the knowledge views.
 *   Storage stays ISO; this is the human-view projection layer (per
 *   proj.knowledge-syntropy AI_PATH_RETURNS_FULL_ROW invariant —
 *   AI consumers fetch raw, humans see this).
 * Scope: Pure presentation. No I/O. Thin adapter: the implementation is published by `@cogni/knowledge-base-ui` (task.0041).
 * @internal
 */

"use client";

export { formatRelativeTime, RelativeTime } from "@cogni/knowledge-base-ui";
