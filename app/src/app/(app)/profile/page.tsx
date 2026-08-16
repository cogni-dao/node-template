// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/profile/page`
 * Purpose: Server entrypoint for the user profile settings page.
 * Scope: Server component only; delegates all client-side behavior to ProfileView. Passes the operator attestation issuer URL (server env) as a prop. Suspense boundary required for useSearchParams().
 * Invariants: Auth enforced by (app) layout guard. force-dynamic so the issuer URL reflects runtime env, not a build-time snapshot.
 * Side-effects: none (server render only)
 * Links: src/app/(app)/profile/view.tsx
 * @public
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { PageSkeleton } from "@/components";

import { ProfileView } from "./view";

export const dynamic = "force-dynamic";

export default function ProfilePage(): ReactElement {
  // Read directly (not serverEnv()) so build-time page collection never
  // requires the full validated env — mirrors auth.ts precedent.
  // biome-ignore lint/style/noProcessEnv: single optional var; full env validation unavailable at build-time page collection
  const operatorIssuerUrl = (
    process.env.COGNI_OPERATOR_ISSUER_URL || "https://cognidao.org"
  ).replace(/\/+$/, "");

  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProfileView operatorIssuerUrl={operatorIssuerUrl} />
    </Suspense>
  );
}
