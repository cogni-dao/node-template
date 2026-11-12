// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Durable requester. One bounded remote effect per advance, always after its durable intent/authorization. */
import type { JWK } from "jose";
import { isWellFormedRevocableKey } from "../../credentials/key-format";
import { generateLinkKeypair } from "../client/keypair";
import type { EnrollmentProofSigner } from "../client/sign";
import {
  EnrollmentClientError,
  type EnrollmentTransport,
} from "../client/transport";
import {
  acceptanceSchema,
  type ConnectionKey,
  canonicalJson,
  connectionKeySchema,
  ENROLLMENT_PROTOCOL,
  ENROLLMENT_CLOCK_MARGIN_MS,
  type EnrollmentProof,
  type EnrollmentReply,
  enrollmentIntentSchema,
  intentDigestOf,
  pendingKeySchema,
} from "../protocol";
import { openSealed } from "../seal";
import { custodyAad, fromBase64, toBase64 } from "./cipher";
import { admitEnrollmentTarget } from "./admission";
import {
  type CustodyCipher,
  type LeaseGuard,
  type LinkHandle,
  type LinkRow,
  type LinkSecrets,
  type LinkState,
  linkView,
  type RequesterStore,
  type RequesterVault,
  type ReplacementBasis,
} from "./types";

const DAY = 86400000;
const terminal = new Set([
  "disconnected",
  "denied",
  "expired",
  "expired_unknown",
  "needs_reenroll",
]);
const guardOf = (row: LinkRow): LeaseGuard => {
  if (!row.leaseOwner) throw new Error("requester_lease_lost");
  return {
    operationId: row.operationId,
    key: row.state.key,
    revision: row.revision,
    fence: row.fence,
    leaseOwner: row.leaseOwner,
  };
};
const hash = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (b) => b.toString(16).padStart(2, "0")
  ).join("");
export interface EnrollmentRequesterOptions {
  signer: EnrollmentProofSigner;
  fetch?: typeof fetch;
  transport: Pick<
    EnrollmentTransport,
    "postProof" | "pollToken" | "confirmStaged"
  >;
  store: RequesterStore;
  vault: RequesterVault;
  cipher: CustodyCipher;
  now?: () => Date;
  newId?: () => string;
}
export function createEnrollmentRequester(options: EnrollmentRequesterOptions) {
  const { signer, transport, store, vault, cipher } = options;
  if (store.durable !== true)
    throw new Error("durable_requester_store_required");
  const now = options.now ?? (() => new Date()),
    newId = options.newId ?? (() => crypto.randomUUID());
  const secretsOf = async (row: LinkRow): Promise<LinkSecrets> => {
    if (!row.encryptedSecrets) throw new Error("requester_secrets_unavailable");
    return JSON.parse(
      await cipher.open(
        fromBase64(row.encryptedSecrets),
        custodyAad(row.state.key, row.operationId, "intent")
      )
    ) as LinkSecrets;
  };
  const sealSecrets = async (
    row: LinkRow,
    secrets: LinkSecrets
  ): Promise<string> =>
    toBase64(
      await cipher.seal(
        JSON.stringify(secrets),
        custodyAad(row.state.key, row.operationId, "intent")
      )
    );
  const latest = async (h: LinkHandle) => {
    const r = await store.read(h);
    if (!r) throw new Error("link_not_found");
    return linkView(r);
  };
  const update = async (
    row: LinkRow,
    state: LinkState,
    extra: {
      encryptedSecrets?: string | null;
      delaySec?: number;
      release?: boolean;
    } = {}
  ) => store.update(guardOf(row), { state, ...extra });
  const continueProof = async (row: LinkRow): Promise<string> => {
    const iat = Math.floor(now().getTime() / 1000);
    const proof: EnrollmentProof = {
      ...row.state.intent,
      op: "continue",
      intentDigest: row.state.intentDigest,
      originalTokenDigest: row.state.originalTokenDigest,
      iss: row.state.key.home.origin,
      aud: `urn:cogni:node:${row.state.key.target.nodeId}`,
      iat,
      exp: iat + 600,
      jti: newId(),
    };
    return signer.signProof(proof);
  };
  async function applyProof(
    row: LinkRow,
    answer: EnrollmentReply
  ): Promise<void> {
    const s = row.state;
    if (
      answer.operationId !== row.operationId ||
      answer.generation !== s.intent.generation
    )
      throw new Error("enrollment_binding_mismatch");
    if (s.connectionId && s.credentialId) {
      if (answer.credentialId !== s.credentialId)
        throw new Error("enrollment_credential_mismatch");
      if (
        answer.credentialState === "revoked" ||
        answer.credentialState === "expired"
      ) {
        await update(
          row,
          {
            ...s,
            phase: "needs_reenroll",
            nextAction: "none",
            quarantined: false,
            error: "key_rejected",
          },
          { release: true }
        );
      } else {
        await update(
          row,
          {
            ...s,
            phase: "confirm_unknown",
            nextAction: "confirm",
            attempts: 0,
            paused: false,
          },
          { delaySec: 5, release: true }
        );
      }
      return;
    }
    if (!answer.sealedAcceptance || answer.status !== "open") {
      await update(
        row,
        {
          ...s,
          phase: answer.status === "denied" ? "denied" : "expired",
          nextAction: "none",
        },
        { release: true }
      );
      return;
    }
    const secrets = await secretsOf(row);
    const a = acceptanceSchema.parse(
      JSON.parse(
        await openSealed(answer.sealedAcceptance, secrets.privateJwk as JWK)
      )
    );
    if (
      a.operationId !== row.operationId ||
      a.generation !== s.intent.generation ||
      a.intentDigest !== s.intentDigest ||
      canonicalJson(a.home) !== canonicalJson(s.key.home) ||
      canonicalJson(a.target) !== canonicalJson(s.key.target) ||
      a.service !== s.key.service ||
      a.scope !== s.intent.scopes[0] ||
      Date.parse(a.recoveryExpiresAt) !== Date.parse(a.acceptedAt) + DAY ||
      Date.parse(a.acceptedAt) >= s.intent.originalStartExp * 1000 ||
      Date.parse(a.acceptedAt) < s.intent.originalStartIat * 1000 ||
      Date.parse(a.recoveryExpiresAt) > s.intent.originalStartExp * 1000 + DAY
    )
      throw new Error("enrollment_binding_mismatch");
    await update(
      row,
      {
        ...s,
        phase: "awaiting_consent",
        nextAction: "poll",
        acceptedAt: a.acceptedAt,
        recoveryExpiresAt: a.recoveryExpiresAt,
        enrollmentId: a.enrollmentId,
        principalUserId: a.principalUserId,
        attempts: 0,
        paused: false,
        error: null,
      },
      {
        encryptedSecrets: await sealSecrets(row, {
          ...secrets,
          deviceCode: a.deviceCode,
        }),
        delaySec: a.interval,
        release: true,
      }
    );
  }
  async function draft(
    key: ConnectionKey,
    previous?: LinkRow,
    basis?: ReplacementBasis
  ): Promise<LinkRow> {
    key = connectionKeySchema.parse(key);
    // Reserve only after the exact signed token/private key are encrypted. An ensure loser never sends its draft.
    const operationId = newId(),
      pair = await generateLinkKeypair(),
      jti = newId(),
      iat = Math.floor(now().getTime() / 1000);
    const remote = previous
      ? basis?.disposition === "not_accepted"
        ? {
            generation: previous.state.intent.expectedGeneration,
            operationId: previous.state.intent.expectedOperationId,
          }
        : {
            generation: previous.state.intent.generation,
            operationId: previous.operationId,
          }
      : { generation: 0, operationId: null };
    const intent = enrollmentIntentSchema.parse({
      kind: ENROLLMENT_PROTOCOL,
      operationId,
      generation: remote.generation + 1,
      expectedGeneration: remote.generation,
      expectedOperationId: remote.operationId,
      home: key.home,
      target: key.target,
      service: key.service,
      scopes: ["knowledge:read"],
      cnf: { jwk: pair.publicJwk },
      originalStartJti: jti,
      originalStartIat: iat,
      originalStartExp: iat + 600,
    });
    const intentDigest = await intentDigestOf(intent);
    const token = await signer.signProof({
      ...intent,
      op: "start",
      intentDigest,
      jti,
      iat,
      exp: iat + 600,
      iss: key.home.origin,
      aud: `urn:cogni:node:${key.target.nodeId}`,
    });
    const row: LinkRow = {
      operationId,
      revision: 0,
      fence: 0,
      encryptedSecrets: null,
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: now().toISOString(),
      secretDeadline: new Date(
        intent.originalStartExp * 1000 + DAY + 60000
      ).toISOString(),
      state: {
        key,
        intent,
        intentDigest,
        originalTokenDigest: await hash(token),
        ...(basis ? { replacementBasis: basis } : {}),
        phase: "start_ready",
        nextAction: "start",
        attempts: 0,
        paused: false,
        error: null,
      },
    };
    row.encryptedSecrets = await sealSecrets(row, {
      token,
      privateJwk: pair.privateJwk,
    });
    return row;
  }
  return {
    async ensure(key: ConnectionKey) {
      key = connectionKeySchema.parse(key);
      await admitEnrollmentTarget(key, options.fetch);
      return linkView(await store.reserve(await draft(key)));
    },
    async reenroll(handle: LinkHandle, expectedRevision: number) {
      const previous = await store.read(handle);
      if (
        !previous ||
        previous.revision !== expectedRevision ||
        !terminal.has(previous.state.phase) ||
        !store.replace
      )
        throw new Error("link_revision_conflict");
      await admitEnrollmentTarget(handle.key, options.fetch);
      // A fresh signed continuation is read-only and can authenticate after the original JWT/private custody expires.
      // It distinguishes a missing attempt from an accepted terminal operation before deriving the next target CAS.
      let disposition: ReplacementBasis["disposition"], observedAt: string;
      try {
        const remote = await transport.postProof(
          handle.key.target.origin, await continueProof(previous)
        );
        const terminalOperation = ["denied", "expired", "superseded"].includes(remote.status);
        const terminalCredential = remote.status === "confirmed" &&
          ["revoked", "expired"].includes(remote.credentialState ?? "");
        if (remote.operationId !== previous.operationId ||
            remote.generation !== previous.state.intent.generation ||
            !(terminalOperation || terminalCredential))
          throw new Error("remote_operation_not_terminal");
        disposition = "terminal";
        observedAt = remote.observedAt;
      } catch (error) {
        if (!(error instanceof EnrollmentClientError) || !error.observedAt ||
            !((error.status === 404 && error.refusal === "unknown_operation") ||
              (error.status === 410 && error.refusal === "terminal_operation"))) throw error;
        disposition = error.status === 404 ? "not_accepted" : "terminal";
        observedAt = error.observedAt;
      }
      if (!Number.isFinite(Date.parse(observedAt)) ||
          (disposition === "not_accepted" &&
            (Date.parse(observedAt) < previous.state.intent.originalStartExp * 1000 ||
             previous.state.acceptedAt || previous.state.enrollmentId ||
             previous.state.connectionId || previous.state.credentialId)))
        throw new Error("remote_reconciliation_required");
      const basis: ReplacementBasis = {
        operationId: previous.operationId, intentDigest: previous.state.intentDigest,
        disposition, observedAt,
      };
      const result = await store.replace(
        handle,
        expectedRevision,
        await draft(handle.key, previous, basis)
      );
      if (!result) throw new Error("link_revision_conflict");
      return linkView(result);
    },
    read: latest,
    async advance(
      handle: LinkHandle,
      action: { resumeRevision?: number } = {}
    ) {
      const before = await store.read(handle);
      if (before?.state.paused && action.resumeRevision === undefined)
        return linkView(before);
      if (
        action.resumeRevision !== undefined &&
        before?.revision !== action.resumeRevision
      )
        throw new Error("link_revision_conflict");
      let row = await store.acquire(handle, newId());
      if (!row) return latest(handle);
      if (terminal.has(row.state.phase) || row.state.phase === "connected") {
        await update(row, row.state, { release: true });
        return latest(handle);
      }
      // A caller explicitly advances the same paused operation; no new identity or consent ask is made.
      if (row.state.paused)
        row =
          (await update(row, { ...row.state, paused: false, attempts: 0 })) ??
          row;
      let continuationSent = false;
      try {
        if (row.state.nextAction === "start") {
          row = await update(row, { ...row.state, phase: "start_unknown" });
          if (!row) return latest(handle);
          const secrets = await secretsOf(row);
          continuationSent = now().getTime() >= row.state.intent.originalStartExp * 1000;
          const token = continuationSent ? await continueProof(row) : secrets.token;
          await applyProof(
            row,
            await transport.postProof(row.state.key.target.origin, token)
          );
        } else if (row.state.nextAction === "continue") {
          continuationSent = true;
          await applyProof(
            row,
            await transport.postProof(
              row.state.key.target.origin,
              await continueProof(row)
            )
          );
        } else if (row.state.nextAction === "poll") {
          const secrets = await secretsOf(row);
          if (!secrets.deviceCode) throw new Error("enrollment_code_missing");
          const answer = await transport.pollToken(
            row.state.key.target.origin,
            secrets.deviceCode
          );
          if (answer.kind === "issued") {
            const envelope = pendingKeySchema.parse(
              JSON.parse(await openSealed(answer.sealedKey, secrets.privateJwk))
            );
            const s = row.state;
            if (
              !isWellFormedRevocableKey(envelope.token) ||
              envelope.operationId !== row.operationId ||
              envelope.generation !== s.intent.generation ||
              envelope.intentDigest !== s.intentDigest ||
              canonicalJson(envelope.home) !== canonicalJson(s.key.home) ||
              canonicalJson(envelope.target) !== canonicalJson(s.key.target) ||
              envelope.service !== s.key.service ||
              envelope.scope !== s.intent.scopes[0] ||
              envelope.enrollmentId !== s.enrollmentId ||
              envelope.principalUserId !== s.principalUserId ||
              envelope.credentialId !== answer.credentialId ||
              envelope.pendingExpiresAt !== answer.pendingExpiresAt ||
              Date.parse(envelope.pendingExpiresAt) >
                Date.parse(s.recoveryExpiresAt ?? "") ||
              Date.parse(envelope.pendingExpiresAt) >
                now().getTime() + 15 * 60000 + ENROLLMENT_CLOCK_MARGIN_MS ||
              Date.parse(envelope.expiresAt) > now().getTime() + 30 * DAY + ENROLLMENT_CLOCK_MARGIN_MS ||
              Date.parse(envelope.renewUntil) >
                Date.parse(envelope.expiresAt) + 14 * DAY
            )
              throw new Error("enrollment_binding_mismatch");
            await store.stage(guardOf(row), envelope);
          } else if (
            answer.kind === "expired_token" ||
            answer.kind === "access_denied"
          ) {
            await update(
              row,
              {
                ...row.state,
                phase: answer.kind === "access_denied" ? "denied" : "expired",
                nextAction: "none",
              },
              { release: true }
            );
          } else {
            await update(
              row,
              {
                ...row.state,
                error:
                  answer.kind === "permission_off" ? "permission_off" : null,
                attempts: 0,
              },
              { delaySec: answer.kind === "slow_down" ? 10 : 5, release: true }
            );
          }
        } else if (row.state.nextAction === "confirm") {
          const { connectionId, credentialId } = row.state;
          if (!connectionId || !credentialId)
            throw new Error("committed_stage_required");
          row = await update(row, { ...row.state, phase: "confirm_unknown" });
          if (!row) return latest(handle);
          const key = await vault.readStaged(
            guardOf(row),
            connectionId,
            credentialId
          );
          if (!key) throw new Error("committed_stage_required");
          const answer = await transport.confirmStaged(
            row.state.key.target.origin,
            key
          );
          if (
            answer.status === 200 &&
            answer.credentialId === credentialId &&
            answer.expiresAt &&
            answer.renewUntil
          ) {
            const observed = answer.observedAt ? Date.parse(answer.observedAt) : now().getTime() + ENROLLMENT_CLOCK_MARGIN_MS;
            if (
              !Number.isFinite(observed) ||
              (answer.observedAt && Math.abs(observed - now().getTime()) > ENROLLMENT_CLOCK_MARGIN_MS) ||
              !Number.isFinite(Date.parse(answer.expiresAt)) || !Number.isFinite(Date.parse(answer.renewUntil)) ||
              Date.parse(answer.expiresAt) > observed + 30 * DAY ||
              Date.parse(answer.renewUntil) >
                Date.parse(answer.expiresAt) + 14 * DAY
            ) {
              await update(
                row,
                {
                  ...row.state,
                  quarantined: true,
                  paused: true,
                  error: "protocol_error",
                  nextAction: "continue",
                },
                { release: true }
              );
              return latest(handle);
            }
            await store.publish(guardOf(row), {
              expiresAt: answer.expiresAt,
              renewUntil: answer.renewUntil,
              ...(answer.observedAt ? { observedAt: answer.observedAt } : {}),
            });
          } else {
            // Throttling and transient confirmation responses use the same bounded retry counter while custody stays staged.
            if (answer.status === 429 || answer.status >= 500)
              throw new EnrollmentClientError("origin_unreachable", answer.status);
            const permissionOff = answer.status === 403 && answer.refusal === "permission_off";
            const reconcile = answer.status === 401 || answer.status === 409 &&
              ["pending_expired", "superseded", "predecessor_revoked"].includes(answer.refusal ?? "");
            if (!permissionOff && !reconcile) throw new Error("confirmation_protocol_error");
            await update(row, { ...row.state, attempts: 0,
              error: permissionOff ? "permission_off" : "unconfirmed",
              nextAction: reconcile ? "continue" : "confirm",
            }, { delaySec: 5, release: true });
          }
        }
      } catch (e) {
        if (row) {
          if (continuationSent && e instanceof EnrollmentClientError &&
              e.code === "enrollment_rejected" && e.status === 404 && e.refusal === "unknown_operation" && e.observedAt &&
              Number.isFinite(Date.parse(e.observedAt)) &&
              Date.parse(e.observedAt) >= row.state.intent.originalStartExp * 1000 &&
              !row.state.acceptedAt && !row.state.enrollmentId &&
              !row.state.connectionId && !row.state.credentialId) {
            // Definitive absence erases only this fenced pre-key intent. It never starts a replacement.
            await update(row, { ...row.state, nonacceptanceObservedAt: e.observedAt,
              phase: "expired_unknown", nextAction: "none", attempts: 0, paused: false, error: null,
            }, { encryptedSecrets: null, release: true });
            return latest(handle);
          }
          if (continuationSent && e instanceof EnrollmentClientError && e.code === "enrollment_rejected" &&
              e.status === 410 && e.refusal === "terminal_operation" && e.observedAt && Number.isFinite(Date.parse(e.observedAt))) {
            // Known terminal receipt is distinct from absent intent. Fence publication, retain the staged key's custody bound.
            await update(row, { ...row.state, terminalObservedAt: e.observedAt,
              phase: "needs_reenroll", nextAction: "none", attempts: 0, paused: false, error: "unconfirmed",
            }, { release: true });
            return latest(handle);
          }
          const transient = e instanceof EnrollmentClientError;
          const attempts = row.state.attempts + 1;
          // Ambiguous replies retain original intent and staged custody. Even authenticated404 never triggers a fresh operation.
          await update(
            row,
            {
              ...row.state,
              attempts,
              paused: attempts >= 5,
              error: transient ? "transient" : "protocol_error",
            },
            {
              delaySec: Math.min(60, 5 * 2 ** Math.min(attempts - 1, 4)),
              release: true,
            }
          );
        }
      }
      return latest(handle);
    },
    async disconnect(handle: LinkHandle, expectedRevision: number) {
      const row = await store.disconnect(handle, expectedRevision);
      if (!row) throw new Error("link_revision_conflict");
      return linkView(row);
    },
  };
}
