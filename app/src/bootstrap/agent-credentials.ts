// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-credentials`
 * Purpose: This node's wiring of the `@cogni-dao/agent-grants/credentials` store: the service-role postgres.js client.
 * Scope: Composition only. `agent_credentials` is deny-all for the app role (FORCE RLS, no policy), so the store gets the
 *   BYPASSRLS service connection. No decision lives here.
 * Side-effects: none (the client is built lazily by the container)
 * Links: packages/agent-grants/src/credentials
 * @internal
 */

import {
  type CredentialSql,
  CredentialStoreUnavailableError,
  type CredentialStore,
  createPostgresCredentialStore,
} from "@cogni/agent-grants/credentials";
import { resolveServiceDb } from "@/bootstrap/container";

let store: CredentialStore | undefined;

/** A missing or broken service connection is an outage (503), never a 500 or a 401. */
export function getAgentCredentialStore(): CredentialStore {
  try {
    store ??= createPostgresCredentialStore(resolveServiceDb().$client as unknown as CredentialSql);
  } catch {
    throw new CredentialStoreUnavailableError();
  }
  return store;
}
