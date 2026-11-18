// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { CredentialSql } from "@cogni/agent-grants/credentials";
import { nodeTupleSchema, sameTuple } from "@cogni/agent-grants/enrollment";
import {
  type ConnectionKey,
  createCustodyCipher,
  connectionKeyDigest,
  createEnrollmentProofSigner,
  createEnrollmentRequester,
  createEnrollmentTransport,
  createPostgresRequesterCustody,
  type LinkHandle,
} from "@cogni/agent-grants/enrollment-requester";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
/** Node-local configuration and client composition for the published durable enrollment capability. */
import { exportJWK, importJWK } from "jose";
import { withTenantScope } from "@cogni/db-client";
import { connections } from "@cogni/db-schema";
import type { ActorId } from "@cogni/ids";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { resolveAppDb, resolveServiceDb } from "./container";

export function serviceHomeTuple() {
  const env = serverEnv();
  return nodeTupleSchema.parse({
    nodeId: getNodeId(),
    environment: env.SERVICE_ENROLLMENT_ENVIRONMENT,
    origin: env.SERVICE_ENROLLMENT_ORIGIN,
  });
}
/** Owner-reviewed trust tuples. Legacy reconciliation is explicit and ambiguous origin/service mappings are refused by the store. */
export function serviceTrustedHomes() {
  const raw = serverEnv().SERVICE_ENROLLMENT_TRUSTED_HOMES;
  if (!raw) throw new Error("trusted_home_configuration_unavailable");
  return z.array(nodeTupleSchema.extend({
    kids: z.array(z.string().min(1)).min(1),
    services: z.record(z.string(), z.array(z.string()).min(1)),
    reconcileLegacy: z.boolean().optional(),
  })).min(1).max(25).parse(JSON.parse(raw));
}
export function serviceTargetRegistry() {
  const raw = serverEnv().SERVICE_LINK_TARGETS;
  if (!raw) throw new Error("service_registry_unavailable");
  return z
    .record(z.string().regex(/^[a-z0-9-]{1,63}$/), nodeTupleSchema)
    .refine((v) => Object.keys(v).length <= 25)
    .parse(JSON.parse(raw));
}
export function serviceConnectionKey(targetAlias: string): ConnectionKey {
  const target = serviceTargetRegistry()[targetAlias];
  if (!target) throw new Error("target_alias_unknown");
  return {
    home: serviceHomeTuple(),
    service: "node-ai",
    billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
    target,
  };
}
export async function serviceSigner() {
  const env = serverEnv();
  if (
    !env.SERVICE_ENROLLMENT_SIGNING_JWK ||
    !env.SERVICE_ENROLLMENT_SIGNING_KID
  )
    throw new Error("service_signer_unavailable");
  const jwk = JSON.parse(env.SERVICE_ENROLLMENT_SIGNING_JWK);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string")
    throw new Error("service_signer_unavailable");
  const key = await importJWK(jwk, "EdDSA");
  const signer = createEnrollmentProofSigner({
    kid: env.SERVICE_ENROLLMENT_SIGNING_KID,
    key,
  });
  // Explicit allowlist: private members cannot reach the public route.
  const pub = await exportJWK(
    await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, "EdDSA")
  );
  return {
    signer,
    jwks: {
      keys: [
        {
          kty: pub.kty,
          crv: pub.crv,
          x: pub.x,
          kid: env.SERVICE_ENROLLMENT_SIGNING_KID,
          alg: "EdDSA",
          use: "sig",
        },
      ],
    },
  };
}
let composed: Promise<Awaited<ReturnType<typeof compose>>> | undefined;
async function compose() {
  const encoded = serverEnv().CONNECTIONS_ENCRYPTION_KEY;
  if (!encoded) throw new Error("service_vault_unavailable");
  const bytes = /^[0-9a-fA-F]{64}$/.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64");
  if (bytes.length !== 32) throw new Error("service_vault_unavailable");
  const cipher = createCustodyCipher(
    Uint8Array.from(bytes),
    "connections-v2"
  );
  const client = resolveServiceDb().$client as unknown as CredentialSql;
  const custody = createPostgresRequesterCustody(client, {
    cipher,
    systemPrincipalUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
    readReadyConnection: async (input) => {
      const digest = await connectionKeyDigest(input.key);
      return withTenantScope(resolveAppDb(), COGNI_SYSTEM_PRINCIPAL_USER_ID as ActorId, async (tx) => {
        const rows = await tx.select({ encryptedCredentials: connections.encryptedCredentials, encryptionKeyId: connections.encryptionKeyId })
          .from(connections).where(and(
            eq(connections.id, input.connectionId), eq(connections.billingAccountId, input.key.billingAccountId),
            eq(connections.provider, "cogni-node"), eq(connections.serviceKeyDigest, digest),
            sql`${connections.serviceIdentity} = ${JSON.stringify(input.key)}::text::jsonb`,
            eq(connections.serviceOperationId, input.operationId), eq(connections.serviceCredentialId, input.credentialId),
            eq(connections.serviceState, "ready"), isNull(connections.revokedAt), gt(connections.expiresAt, sql`clock_timestamp()`)
          )).limit(1);
        return rows[0] ?? null;
      });
    },
  });
  const { signer } = await serviceSigner();
  return {
    ...custody,
    requester: createEnrollmentRequester({
      signer,
      transport: createEnrollmentTransport(),
      cipher,
      ...custody,
    }),
  };
}
export function getServiceLinks() {
  composed ??= compose().catch((e) => {
    composed = undefined;
    throw e;
  });
  return composed;
}
/** A link id is resolved only within this home/system tenant and the configured target registry. */
export async function serviceLinkHandle(
  linkId: string
): Promise<LinkHandle | null> {
  if (!z.string().uuid().safeParse(linkId).success) return null;
  const client = resolveServiceDb().$client as unknown as CredentialSql;
  const r =
    await client`SELECT state->'key' AS key FROM agent_service_link_operations WHERE operation_id=${linkId} AND billing_account_id=${COGNI_SYSTEM_BILLING_ACCOUNT_ID}`;
  const key = r[0]?.key as ConnectionKey | undefined;
  if (
    !key ||
    key.service !== "node-ai" ||
    !sameTuple(key.home, serviceHomeTuple()) ||
    !Object.values(serviceTargetRegistry()).some((t) =>
      sameTuple(t, key.target)
    )
  )
    return null;
  return { operationId: linkId, key };
}
