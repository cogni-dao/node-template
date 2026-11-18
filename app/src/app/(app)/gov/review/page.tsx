// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/review/page`
 * Purpose: Server entrypoint for the Finish Epoch workspace.
 * Scope: Resolves the signed-in wallet (the finalize signer) and the one node-admin decision for client-side action eligibility.
 * Invariants: Unauthorized users may inspect progress (the page renders public epoch data); the attribution write routes remain the authorization boundary. ONE_ADMIN_CHECK: `isNodeAdmin` is `agentAuthority.adminCheck` on the caller's bound wallets; the login wallet never decides.
 * Side-effects: IO (auth session read, bound-wallet read)
 * Links: src/app/api/v1/attribution/_lib/admin-guard.ts
 * @public
 */

import type { ReactElement } from "react";

import { getContainer } from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import { getNodeId } from "@/shared/config";

import { ReviewView } from "./view";

export default async function ReviewPage(): Promise<ReactElement> {
  const user = await getServerSessionUser();
  const isNodeAdmin = user
    ? (await getContainer()
        .agentAuthority.adminCheck(user.id)
        .catch(() => "unavailable" as const)) === "allow"
    : false;

  return (
    <ReviewView
      // The signer of the EIP-712 finalize signature, never authority.
      walletAddress={user?.walletAddress?.toLowerCase() ?? null}
      isNodeAdmin={isNodeAdmin}
      operatorSetupUrl={`https://cognidao.org/nodes/${getNodeId()}`}
    />
  );
}
