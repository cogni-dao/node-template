// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/layout/user-avatar-menu`
 * Purpose: Verify logout failure is visible and retryable from the account menu.
 * Scope: Component state with mocked auth, wallet, and logout orchestration. No IO.
 * Invariants: Failed logout retains the authenticated menu and exposes a retry action.
 * Side-effects: none
 * Links: src/features/layout/components/UserAvatarMenu.tsx, bug.5045
 * @vitest-environment jsdom
 */

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disconnect: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "user-a",
        displayName: "Wallet User",
        walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
  }),
}));

vi.mock("wagmi", () => ({
  useDisconnect: () => ({ disconnectAsync: mocks.disconnect }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/features/layout/logout", () => ({
  logoutBrowserSession: mocks.logout,
}));

import { UserAvatarMenu } from "@/features/layout/components/UserAvatarMenu";

describe("UserAvatarMenu logout", () => {
  beforeEach(() => {
    mocks.disconnect.mockReset();
    mocks.logout.mockReset();
  });

  it("shows a retry action without disconnecting when logout fails", async () => {
    const user = userEvent.setup();
    mocks.logout
      .mockRejectedValueOnce(new Error("Sign out was rejected. Please try again."))
      .mockResolvedValueOnce(undefined);

    render(<UserAvatarMenu />);
    await user.click(screen.getByRole("button", { name: "User menu" }));
    await user.click(screen.getByText("Sign Out"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign out was rejected. Please try again."
    );
    expect(screen.getByText("Retry Sign Out")).toBeInTheDocument();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.logout).toHaveBeenCalledWith(mocks.disconnect);

    await user.click(screen.getByText("Retry Sign Out"));
    expect(mocks.logout).toHaveBeenCalledTimes(2);
  });
});
