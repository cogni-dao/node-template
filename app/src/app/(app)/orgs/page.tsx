// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/orgs/page`
 * Purpose: `/orgs`: the orgs a person is in, the invites waiting for them, and Create org.
 * Scope: Server component; auth is enforced by `proxy.ts` and the (app) layout. Renders the shared section only.
 * Invariants: ANYONE_CREATES (any signed-in person may create an org).
 * Side-effects: none (server render only)
 * Links: ./Orgs.client.tsx
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { OrgsClient } from "./Orgs.client";

export default function OrgsPage(): ReactElement {
  return (
    <PageContainer maxWidth="2xl">
      <OrgsClient />
    </PageContainer>
  );
}
