// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials`
 * Purpose: Public surface of revocable hashed agent credentials (v2 keys). A node adopts this subpath alone.
 * Scope: Re-exports only.
 * Side-effects: none
 * @public
 */

export { createPostgresCredentialStore, type CredentialSql } from "./postgres";
export {
  AGENT_KEY_V2_PREFIX,
  assertV1NotSuperseded,
  confirmCredential,
  CredentialStoreUnavailableError,
  hashAgentKey,
  isAgentKeyV2,
  type MintedKey,
  revokeCredential,
  rotateCredential,
  upgradeFromV1,
  V1SupersededError,
  type VerifyResult,
  verifyBearer,
} from "./service";
export {
  type ConfirmResult,
  type CredentialCreatedFrom,
  type CredentialLookup,
  type CredentialPolicy,
  type CredentialState,
  type CredentialStore,
  DEFAULT_CREDENTIAL_POLICY,
  type IssueRefusal,
  type IssueResult,
} from "./types";
