// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/BoundedBrowse`
 * Purpose: Compose the package Browse capability with this node's transport, known filter values and exact-ID detail sheet.
 * Scope: Composition only. Table, controls, windows and search live in `@cogni/knowledge-base-ui` (task.0059).
 * @internal
 */

"use client";

import { KnowledgeBrowse } from "@cogni/knowledge-base-ui/knowledge";
import { EntryTypeSchema, SourceTypeSchema } from "@cogni/knowledge-store";
import type { KnowledgeBrowsePage } from "@cogni/node-contracts";
import { useState } from "react";

import { fetchBrowse } from "../_api/fetchBrowse";
import { KnowledgeSelection } from "./KnowledgeSelection";

export function BoundedBrowse({
  initialData,
}: {
  readonly initialData?: KnowledgeBrowsePage | undefined;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <KnowledgeBrowse
      fetchBrowse={fetchBrowse}
      initialData={initialData}
      entryTypeOptions={EntryTypeSchema.options}
      sourceTypeOptions={SourceTypeSchema.options}
      onSelect={(entry) => setSelectedId(entry.id)}
    >
      <KnowledgeSelection id={selectedId} onClose={() => setSelectedId(null)} />
    </KnowledgeBrowse>
  );
}
