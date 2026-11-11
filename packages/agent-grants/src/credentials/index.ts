// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials`
 * Purpose: Public surface of revocable hashed agent credentials (revocable keys). A node adopts this subpath alone.
 * Scope: Re-exports only.
 * Side-effects: none
 * @public
 */

export {
  type CredentialHttpInput,
  type CredentialHttpResponse,
  confirmAgentCredentialOperation,
  credentialDenialHttp,
  credentialErrorHttp,
  credentialHttp,
  revokeAgentCredentialOperation,
  rotateAgentCredentialOperation,
  upgradeAgentCredentialOperation,
} from "./http";
export { agentRolesHasRoles, createPostgresCredentialStore, type CredentialSql, type PostgresCredentialStoreOptions } from "./postgres";
export {
  formatRevocableKey,
  isRevocableKey,
  isWellFormedRevocableKey,
  REVOCABLE_KEY_PREFIX,
  REVOCABLE_KEY_SCAN_PATTERN,
} from "./key-format";
export {
  assertV1NotSuperseded,
  confirmCredential,
  CredentialRateLimitedError,
  CredentialStoreUnavailableError,
  hashAgentKey,
  type MintedKey,
  revokeCredential,
  rotateCredential,
  storeFailureFields,
  upgradeSignedKey,
  V1SupersededError,
  type VerifyOptions,
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
  type HasRoles,
  type IssueRefusal,
  type IssueResult,
} from "./types";
