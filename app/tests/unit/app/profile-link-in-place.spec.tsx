// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/profile-link-in-place.spec`
 * Purpose: Prove GitHub linking finishes in place on the profile page (task.5451).
 * Scope: ProfileView attestation return leg (#attestation=<jwt>) and legacy ?error= handling. Does not exercise the operator hub or OAuth round trip.
 * Invariants: no full reload (window.location.replace never called); URL cleaned via history.replaceState; pending shows on the GitHub row; errors persist on the row with Retry.
 * Side-effects: none (fetch, next-auth, next/navigation, RainbowKit mocked)
 * Links: src/app/(app)/profile/view.tsx
 * @vitest-environment happy-dom
 * @internal
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
const updateSession = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useSearchParams: () => search.params,
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
  useSession: () => ({
    data: { user: { walletAddress: null, displayName: "Tester" } },
    update: updateSession,
  }),
}));

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}));

vi.mock("@/components", () => {
  const Icon = () => null;
  return {
    Avatar: (props: { children: React.ReactNode }) => (
      <div>{props.children}</div>
    ),
    AvatarFallback: (props: { children: React.ReactNode }) => (
      <span>{props.children}</span>
    ),
    Button: ({
      asChild: _asChild,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      asChild?: boolean;
    }) => <button type="button" {...props} />,
    PageContainer: (props: { children: React.ReactNode }) => (
      <main>{props.children}</main>
    ),
    DiscordIcon: Icon,
    EthereumIcon: Icon,
    GitHubIcon: Icon,
    GoogleIcon: Icon,
  };
});

vi.mock("@/features/ai/icons/providers/OpenAIIcon", () => ({
  OpenAIIcon: () => null,
}));

import { ProfileView } from "@/app/(app)/profile/view";

interface Deferred {
  promise: Promise<Response>;
  resolve: (res: Response) => void;
}

function deferred(): Deferred {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMPTY_PROFILE = {
  displayName: null,
  avatarColor: null,
  resolvedDisplayName: "Tester",
  linkedProviders: [],
};

/** Routes fetch by URL. GitHub is NOT configured locally → hub row. */
function mockFetch(importResponse: Promise<Response>): {
  linked: { value: boolean };
} {
  const linked = { value: false };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      if (input === "/api/v1/users/me") {
        return Promise.resolve(
          json(
            linked.value
              ? {
                  ...EMPTY_PROFILE,
                  linkedProviders: [
                    { provider: "github", providerLogin: "octocat" },
                  ],
                }
              : EMPTY_PROFILE
          )
        );
      }
      if (input === "/api/auth/providers") {
        return Promise.resolve(
          json({ credentials: { id: "credentials" } })
        );
      }
      if (input === "/api/v1/identity/bindings/import") {
        return importResponse;
      }
      return Promise.resolve(json({ connected: false }));
    })
  );
  return { linked };
}

describe("ProfileView — GitHub linking finishes in place (task.5451)", () => {
  let replaceState: ReturnType<typeof vi.spyOn>;
  let locationReplace: ReturnType<typeof vi.fn<(url: string | URL) => void>>;

  beforeEach(() => {
    search.params = new URLSearchParams();
    updateSession.mockClear();
    window.history.pushState(null, "", "/profile#attestation=jwt.token.sig");
    replaceState = vi.spyOn(window.history, "replaceState");
    locationReplace = vi.fn<(url: string | URL) => void>();
    window.location.replace = locationReplace;
  });

  afterEach(() => {
    replaceState.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows a row-level pending state, then the linked login without a reload", async () => {
    const importRes = deferred();
    const { linked } = mockFetch(importRes.promise);

    render(<ProfileView />);

    // Pending: one calm status on the GitHub row, no page-wide takeover.
    expect(await screen.findByRole("status")).toHaveTextContent("Linking…");
    expect(screen.getByText("Profile")).toBeInTheDocument();
    // Token leaves the URL immediately, without navigation.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/profile");
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/identity/bindings/import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "jwt.token.sig" }),
      })
    );

    linked.value = true;
    await act(async () => {
      importRes.resolve(json({ githubLogin: "octocat" }));
    });

    expect(await screen.findByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Linked just now")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(updateSession).toHaveBeenCalled();
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it("keeps a mapped error on the GitHub row with Retry, never auto-dismissed", async () => {
    mockFetch(Promise.resolve(json({ errorCode: "invalid_token" }, 400)));

    render(<ProfileView />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "GitHub verification token was invalid or expired. Please try again."
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(locationReplace).not.toHaveBeenCalled();

    // Still there after further renders/time — no stripping effect clears it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("maps unknown attestation errors to the generic link failure", async () => {
    mockFetch(Promise.resolve(json({ errorCode: "something_else" }, 500)));

    render(<ProfileView />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Account linking failed. Please try again."
    );
  });

  it("renders a legacy ?error= persistently after cleaning the URL", async () => {
    window.history.pushState(null, "", "/profile?error=already_linked");
    search.params = new URLSearchParams("error=already_linked");
    mockFetch(Promise.resolve(json({})));

    render(<ProfileView />);

    await waitFor(() =>
      expect(replaceState).toHaveBeenCalledWith(null, "", "/profile")
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That account is already linked to a different user."
    );
    expect(locationReplace).not.toHaveBeenCalled();
  });
});
