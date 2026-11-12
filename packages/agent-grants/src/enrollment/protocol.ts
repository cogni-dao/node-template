// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Strict v2 wire and immutable identity. No host, environment or authority is inferred. */
import { z } from "zod";

const hashAgentKey = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );
  return Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
};

import { isHttpsOrigin, serviceEnrollmentCnfJwk } from "./claims";

export const ENROLLMENT_PROTOCOL = "service.enrollment.v2";
export const nodeTupleSchema = z.strictObject({
  nodeId: z.string().uuid(),
  environment: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  origin: z.string().refine(isHttpsOrigin),
});
export type NodeTuple = z.infer<typeof nodeTupleSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const immutableShape = {
  kind: z.literal(ENROLLMENT_PROTOCOL),
  operationId: z.string().uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedGeneration: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  expectedOperationId: z.string().uuid().nullable(),
  home: nodeTupleSchema,
  target: nodeTupleSchema,
  service: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  scopes: z
    .array(z.string().regex(/^[a-z][a-z0-9_.-]*:[a-z0-9_.-]+$/))
    .length(1),
  cnf: z.strictObject({ jwk: serviceEnrollmentCnfJwk }),
  originalStartJti: z.string().uuid(),
  originalStartIat: z.number().int().nonnegative(),
  originalStartExp: z.number().int().positive(),
};
export const enrollmentIntentSchema = z
  .strictObject(immutableShape)
  .superRefine((v, ctx) => {
    if (
      v.generation !== v.expectedGeneration + 1 ||
      (v.expectedGeneration === 0) !== (v.expectedOperationId === null) ||
      v.originalStartExp <= v.originalStartIat ||
      v.originalStartExp - v.originalStartIat > 600
    ) {
      ctx.addIssue({
        code: "custom",
        message: "invalid immutable generation or deadline",
      });
    }
  });
export type EnrollmentIntent = z.infer<typeof enrollmentIntentSchema>;
const proofShape = {
  ...immutableShape,
  iss: z.string().refine(isHttpsOrigin),
  aud: z.string(),
  intentDigest: digest,
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
};
export const enrollmentProofSchema = z
  .discriminatedUnion("op", [
    z.strictObject({ ...proofShape, op: z.literal("start") }),
    z.strictObject({
      ...proofShape,
      op: z.literal("continue"),
      originalTokenDigest: digest,
    }),
  ])
  .superRefine((v, ctx) => {
    const validIntent = enrollmentIntentSchema.safeParse(intentOf(v));
    if (
      !validIntent.success ||
      v.iss !== v.home.origin ||
      v.aud !== `urn:cogni:node:${v.target.nodeId}` ||
      v.exp <= v.iat ||
      v.exp - v.iat > 600 ||
      (v.op === "start" &&
        (v.jti !== v.originalStartJti ||
          v.iat !== v.originalStartIat ||
          v.exp !== v.originalStartExp))
    ) {
      ctx.addIssue({ code: "custom", message: "invalid proof binding" });
    }
  });
export type EnrollmentProof = z.infer<typeof enrollmentProofSchema>;
export function intentOf(value: EnrollmentIntent): EnrollmentIntent {
  return Object.fromEntries(
    Object.keys(immutableShape).map((key) => [
      key,
      value[key as keyof EnrollmentIntent],
    ])
  ) as EnrollmentIntent;
}
/** Recursive key ordering, UTF-8, JSON numbers/strings; never depend on caller insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(",")}}`;
}
export const intentDigestOf = (value: EnrollmentIntent): Promise<string> =>
  hashAgentKey(canonicalJson(intentOf(value)));
export const sameTuple = (a: NodeTuple, b: NodeTuple): boolean =>
  canonicalJson(a) === canonicalJson(b);
export const fullServiceKey = async (
  home: NodeTuple,
  service: string
): Promise<string> =>
  `urn:cogni:service:${await hashAgentKey(canonicalJson({ home, service }))}`;

export const connectionKeySchema = z.strictObject({
  home: nodeTupleSchema,
  target: nodeTupleSchema,
  service: immutableShape.service,
  billingAccountId: z.string().min(1),
});
export type ConnectionKey = z.infer<typeof connectionKeySchema>;
export const connectionKeyDigest = (key: ConnectionKey): Promise<string> =>
  hashAgentKey(canonicalJson(connectionKeySchema.parse(key)));
const bindingShape = {
  protocol: z.literal(ENROLLMENT_PROTOCOL),
  operationId: z.string().uuid(),
  generation: z.number().int().positive(),
  intentDigest: digest,
  home: nodeTupleSchema,
  target: nodeTupleSchema,
  service: immutableShape.service,
  scope: z.string(),
};
export const acceptanceSchema = z.strictObject({
  ...bindingShape,
  enrollmentId: z.string().uuid(),
  principalUserId: z.string(),
  deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  acceptedAt: z.string().datetime(),
  recoveryExpiresAt: z.string().datetime(),
  interval: z.number().int().min(5).max(60),
});
export type EnrollmentAcceptance = z.infer<typeof acceptanceSchema>;
export const pendingKeySchema = z.strictObject({
  ...bindingShape,
  enrollmentId: z.string().uuid(),
  principalUserId: z.string(),
  credentialId: z.string().uuid(),
  token: z.string(),
  pendingExpiresAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  renewUntil: z.string().datetime(),
});
export type PendingKeyEnvelope = z.infer<typeof pendingKeySchema>;
export const enrollmentStatusSchema = z.enum([
  "open",
  "confirmed",
  "denied",
  "expired",
  "superseded",
]);
export const enrollmentReplySchema = z.strictObject({
  operationId: z.string().uuid(),
  generation: z.number().int().positive(),
  status: enrollmentStatusSchema,
  sealedAcceptance: z.string().nullable(),
  credentialId: z.string().uuid().nullable(),
  credentialState: z
    .enum(["pending", "active", "renew_only", "expired", "revoked"])
    .nullable(),
  observedAt: z.string().datetime(),
});
export type EnrollmentReply = z.infer<typeof enrollmentReplySchema>;
