// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/providers.client`
 * Purpose: Client boundary composing platform providers with node-local wagmiConfig.
 * Scope: Composes Wagmi + Auth + Query + RainbowKit/SIWE in the canonical order
 *   prescribed by RainbowKit (https://rainbowkit.com/docs/authentication):
 *   WagmiProvider (outermost) → SessionProvider (via @cogni/node-app AuthProvider) →
 *   QueryClientProvider → RainbowKitSiweNextAuthProvider → RainbowKitProvider.
 * Invariants:
 *   - Mounts `ApprovalFragmentScrub` once at the root of the client tree: it removes only `#agent-request=` on non-/profile
 *     paths on first mount. It sits here, in the root layout's client boundary, because the package index is not a client
 *     module; a test (tests/unit/app/agent-access-wiring.test.ts) fails if this mount moves.
 *   - WagmiProvider receives `initialState` from `cookieToInitialState` in the server
 *     layout — required for SSR hydration without mismatch.
 *   - WagmiProvider is the outermost provider so Wagmi state is available to every
 *     descendant and `cookieToInitialState` hydrates a single root.
 *   - RainbowKitSiweNextAuthProvider remains a descendant of SessionProvider so it
 *     can read the next-auth session.
 * Side-effects: `history.replaceState` once on first mount (the scrub, only when the URL holds `#agent-request=` off /profile)
 * Links: layout.tsx, packages/node-app/src/providers/, src/shared/web3/wagmi.config.ts
 * @public
 */

"use client";

import {
  AuthProvider,
  createAppDarkTheme,
  createAppLightTheme,
  QueryProvider,
} from "@cogni/node-app/providers";
import { ApprovalFragmentScrub } from "@cogni/knowledge-base-ui/approval-fragment-scrub";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { RainbowKitSiweNextAuthProvider } from "@rainbow-me/rainbowkit-siwe-next-auth";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { type State, WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/shared/web3/wagmi.config";

function RainbowKitThemeProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const theme = useMemo(
    () =>
      mounted && resolvedTheme === "light"
        ? createAppLightTheme()
        : createAppDarkTheme(),
    [mounted, resolvedTheme]
  );

  return <RainbowKitProvider theme={theme}>{children}</RainbowKitProvider>;
}

export function Providers({
  children,
  initialState,
}: {
  readonly children: ReactNode;
  readonly initialState?: State | undefined;
}): ReactNode {
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <ApprovalFragmentScrub />
      <AuthProvider>
        <QueryProvider>
          <RainbowKitSiweNextAuthProvider
            getSiweMessageOptions={() => ({
              statement: "Sign in with Ethereum to the app.",
            })}
          >
            <RainbowKitThemeProvider>{children}</RainbowKitThemeProvider>
          </RainbowKitSiweNextAuthProvider>
        </QueryProvider>
      </AuthProvider>
    </WagmiProvider>
  );
}
