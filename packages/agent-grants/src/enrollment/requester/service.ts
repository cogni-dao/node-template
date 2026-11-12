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
  type EnrollmentProof,
  type EnrollmentReply,
  enrollmentIntentSchema,
  intentDigestOf,
  pendingKeySchema,
} from "../protocol";
import { openSealed } from "../seal";
import { custodyAad, fromBase64, toBase64 } from "./cipher";
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
    previous?: LinkRow
  ): Promise<LinkRow> {
    key = connectionKeySchema.parse(key);
    // Reserve only after the exact signed token/private key are encrypted. An ensure loser never sends its draft.
    const operationId = newId(),
      pair = await generateLinkKeypair(),
      jti = newId(),
      iat = Math.floor(now().getTime() / 1000);
    const intent = enrollmentIntentSchema.parse({
      kind: ENROLLMENT_PROTOCOL,
      operationId,
      generation: previous ? previous.state.intent.generation + 1 : 1,
      expectedGeneration: previous?.state.intent.generation ?? 0,
      expectedOperationId: previous?.operationId ?? null,
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
      const result = await store.replace(
        handle,
        expectedRevision,
        await draft(handle.key, previous)
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
      try {
        if (row.state.nextAction === "start") {
          row = await update(row, { ...row.state, phase: "start_unknown" });
          if (!row) return latest(handle);
          const secrets = await secretsOf(row);
          const token =
            now().getTime() < row.state.intent.originalStartExp * 1000
              ? secrets.token
              : await continueProof(row);
          await applyProof(
            row,
            await transport.postProof(row.state.key.target.origin, token)
          );
        } else if (row.state.nextAction === "continue") {
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
                now().getTime() + 15 * 60000 ||
              Date.parse(envelope.expiresAt) > now().getTime() + 30 * DAY ||
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
            if (
              Date.parse(answer.expiresAt) > now().getTime() + 30 * DAY ||
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
            });
          } else {
            await update(
              row,
              {
                ...row.state,
                error: answer.status === 403 ? "permission_off" : "unconfirmed",
                nextAction: answer.status === 401 ? "continue" : "confirm",
              },
              { delaySec: 5, release: true }
            );
          }
        }
      } catch (e) {
        if (row) {
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
