// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-detail-evidence`
 * Purpose: The slide-over sheet renders the same entry body as `/knowledge/[id]`: a metric shows its
 *   chart and brief, a goal its board. Defect: the sheet showed only the fields (task.0125).
 * Scope: KnowledgeDetail with the evidence mounts replaced by markers. No network.
 * Side-effects: none
 * Links: src/app/(app)/knowledge/_components/KnowledgeEntryBody.tsx
 * @vitest-environment jsdom
 * @internal
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeDetail } from "@/app/(app)/knowledge/_components/KnowledgeDetail";

const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
vi.mock("@/components", () => ({ Sheet: pass, SheetContent: pass, SheetHeader: pass, SheetTitle: pass }));
vi.mock("@/app/(app)/knowledge/_components/KnowledgeEntryFields", () => ({ KnowledgeEntryFields: () => <p>fields</p> }));
vi.mock("@/app/(app)/knowledge/_components/CopyLinkButton", () => ({ CopyLinkButton: () => null }));
vi.mock("@/app/(app)/knowledge/_components/GoalsMount", () => ({
  KnowledgeMetricEvidence: ({ id }: { id: string }) => <p>metric evidence {id}</p>,
  KnowledgeGoalsBoard: ({ goalId }: { goalId: string }) => <p>goal board {goalId}</p>,
  KnowledgeKpiEvidence: () => <p>kpi evidence</p>,
}));

const entry = (extra: object) =>
  ({ id: "m", domain: "strategy", title: "M", content: "c", entryType: "metric", ...extra }) as never;

afterEach(cleanup);

describe("knowledge sheet body", () => {
  it("shows a metric's chart and brief like the entry page", () => {
    render(<KnowledgeDetail item={entry({ metricSpec: { calculatorId: "work.count@1" } })} open onOpenChange={() => {}} />);
    expect(screen.getByText("metric evidence m")).toBeTruthy();
    expect(screen.getByText("fields")).toBeTruthy();
  });

  it("shows only the fields for an entry with no measurement", () => {
    render(<KnowledgeDetail item={entry({ entryType: "guide", metricSpec: null })} open onOpenChange={() => {}} />);
    expect(screen.queryByText(/metric evidence/)).toBeNull();
    expect(screen.getByText("fields")).toBeTruthy();
  });
});
