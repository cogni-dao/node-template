// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** The route binds the shared public view to the node-owned boundary.
 * Epoch controls and their states are exercised by knowledge-base-ui's public fixtures.
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cogni/knowledge-base-ui/epochs", () => ({
  CurrentEpochView: () => <div>Shared epoch view</div>,
}));
vi.mock("@/features/governance/components/EpochsBoundary", () => ({
  EpochsBoundary: ({ children }: { children: ReactNode }) => (
    <section aria-label="Node epoch boundary">{children}</section>
  ),
}));

import { CurrentEpochView } from "@/app/(app)/gov/epoch/view";

describe("Epoch page wiring", () => {
  it("renders the shared public view inside the node boundary", () => {
    render(<CurrentEpochView />);
    expect(screen.getByLabelText("Node epoch boundary")).toContainElement(
      screen.getByText("Shared epoch view")
    );
  });
});
