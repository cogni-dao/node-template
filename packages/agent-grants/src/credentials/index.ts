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
  bindGithubOperation,
  confirmAgentCredentialOperation,
  credentialDenialHttp,
  credentialErrorHttp,
  credentialHttp,
  liftStopOperation,
  proofChallengeOperation,
  recoverCredentialOperation,
  revokeAgentCredentialOperation,
  revokePrincipalOperation,
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
  type CommentRead,
  createGithubCommentVerifier,
  evaluateProofComment,
  githubCommentUrl,
  type GithubVerifierOptions,
  type IssueRef,
  isWellFormedChallengeSecret,
  parseIssueAllowlist,
  parseIssueRef,
  parseProofLine,
  type ProofComment,
  type ProofEvaluation,
  type ProofExpectation,
  type ProofFailure,
  type ProofVerifier,
  proofLine,
} from "./proofs";
export {
  assertV1NotSuperseded,
  bindGithubIdentity,
  type BindOutcome,
  type ChallengeOutcome,
  confirmCredential,
  CredentialRateLimitedError,
  CredentialStoreUnavailableError,
  hashAgentKey,
  issueProofChallenge,
  liftPrincipalStop,
  type LiftOutcome,
  type MintedKey,
  type ProofAttempt,
  type ProofConfig,
  type ProofRefusal,
  recoverCredential,
  type RecoverOutcome,
  revokeCredential,
  revokePrincipalCredentials,
  type StopActor,
  type StopOutcome,
  rotateCredential,
  storeFailureFields,
  upgradeSignedKey,
  V1SupersededError,
  type VerifyOptions,
  type VerifyResult,
  verifyBearer,
} from "./service";
export {
  type ChallengeIssueResult,
  type ChallengeRefusal,
  type ConfirmResult,
  type CredentialCreatedFrom,
  type CredentialLookup,
  type CredentialPolicy,
  type CredentialState,
  type CredentialStore,
  DEFAULT_CREDENTIAL_POLICY,
  DEFAULT_PROOF_POLICY,
  type GithubEvidence,
  type HasRoles,
  type IssueRefusal,
  type IssueResult,
  type KeyHolder,
  type ProofPolicy,
  type ProofPurpose,
} from "./types";
