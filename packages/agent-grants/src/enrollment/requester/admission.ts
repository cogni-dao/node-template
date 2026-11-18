// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared bounded discovery gate before durable intent admission. Hosts supply only registry-resolved K and optional fetch. */
import { z } from "zod";
import { readBoundedText } from "../client/bounded-body";
import { type ConnectionKey, ENROLLMENT_PROTOCOL, nodeTupleSchema, sameTuple } from "../protocol";

export class EnrollmentAdmissionError extends Error {
  constructor(readonly code: "target_unavailable" | "target_identity_mismatch" | "unsupported_credential_policy") {
    super(code);
    this.name = "EnrollmentAdmissionError";
  }
}
const ceilingsSchema = z.strictObject({
  ttlSec: z.number().int().positive().max(30 * 86400),
  renewWindowSec: z.number().int().nonnegative().max(14 * 86400),
  pendingSec: z.number().int().positive().max(15 * 60),
});
export async function admitEnrollmentTarget(key: ConnectionKey, fetcher: typeof fetch = fetch): Promise<void> {
  let discovery: unknown;
  try {
    const res = await fetcher(new URL("/.well-known/agent.json", key.target.origin), {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000), headers: { accept: "application/json" },
    });
    const body = await readBoundedText(res, 64 * 1024);
    if (!res.ok || !body.ok) throw new Error("unavailable");
    discovery = JSON.parse(body.text);
  } catch {
    throw new EnrollmentAdmissionError("target_unavailable");
  }
  const identity = z.object({
    nodeId: z.string().uuid(),
    serviceEnrollment: z.object({ protocol: z.literal(ENROLLMENT_PROTOCOL), receiver: nodeTupleSchema, credentialCeilings: z.unknown() }),
  }).safeParse(discovery);
  if (!identity.success || identity.data.nodeId !== key.target.nodeId || !sameTuple(identity.data.serviceEnrollment.receiver, key.target))
    throw new EnrollmentAdmissionError("target_identity_mismatch");
  if (!ceilingsSchema.safeParse(identity.data.serviceEnrollment.credentialCeilings).success)
    throw new EnrollmentAdmissionError("unsupported_credential_policy");
}
