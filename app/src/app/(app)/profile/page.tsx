// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/profile/page`
 * Purpose: Server entrypoint for the user profile settings page.
 * Scope: Reads the signed-in user's profile, linked accounts and configured providers on the
 *   server for this request, then hands them to ProfileView as initial state. Mutations stay
 *   in ProfileView.
 * Invariants:
 *   - Auth enforced by (app) layout guard.
 *   - FIRST_PAINT_IS_TRUE: linked accounts arrive with the HTML; the client never shows
 *     "Link" for an account it has not read yet. A failed server read falls back to the
 *     client fetch rather than failing the page.
 * Side-effects: IO (session + database read)
 * Links: src/app/(app)/profile/view.tsx, src/app/_facades/users/profile.server.ts
 * @public
 */

import type { ReactElement } from "react";
import { Suspense } from "react";

import { readProfile } from "@/app/_facades/users/profile.server";
import { authOptions } from "@/auth";
import { PageSkeleton } from "@/components";
import { getServerSessionUser } from "@/lib/auth/server";

import { ProfileView } from "./view";

export const dynamic = "force-dynamic";

async function ProfileWithServerData(): Promise<ReactElement> {
  const user = await getServerSessionUser();
  const initialProfile = user ? await readProfile(user).catch(() => null) : null;
  const initialProviders = authOptions.providers
    .map((provider) => provider.id)
    .filter((id) => id !== "credentials");
  return (
    <ProfileView
      initialProfile={initialProfile}
      initialProviders={initialProviders}
    />
  );
}

export default function ProfilePage(): ReactElement {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProfileWithServerData />
    </Suspense>
  );
}
