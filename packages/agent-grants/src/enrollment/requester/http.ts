// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Shared service-link operations and host-only bounded useful read. Nodes supply auth/registry/client creation. */
import { z } from "zod";
import { REVOCABLE_KEY_SCAN_PATTERN } from "../../credentials/key-format";
import { readBoundedText } from "../client/bounded-body";
import { type ConnectionKey, canonicalJson } from "../protocol";
import type { createEnrollmentRequester } from "./service";
import { EnrollmentAdmissionError } from "./admission";
import type { LinkHandle, RequesterStore, RequesterVault } from "./types";
export const serviceLinkCreateInput = z.strictObject({
  targetAlias: z.string().regex(/^[a-z0-9-]{1,63}$/),
  service: z.literal("node-ai"),
  replace: z
    .strictObject({
      linkId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .optional(),
});
export const serviceLinkDisconnectInput = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
});
export interface ServiceLinkHost {
  requester: ReturnType<typeof createEnrollmentRequester>;
  store: RequesterStore;
  vault: RequesterVault;
  keyForAlias(alias: string): ConnectionKey;
  handleForId(id: string): Promise<LinkHandle | null>;
  allowedEntries: readonly string[];
  fetch?: typeof fetch;
}
export interface ServiceLinkAnswer {
  status: number;
  body: unknown;
  headers: { "cache-control": "no-store" };
}
const answer = (status: number, body: unknown): ServiceLinkAnswer => ({
  status,
  body,
  headers: { "cache-control": "no-store" },
});
/** Redact after decoding so escaped JSON values and object keys cannot reconstruct a credential. */
function redactDecodedKnowledge(value: unknown, bearer: string): unknown {
  let remaining = 50000;
  const redact = (text: string) => text.split(bearer).join("[REDACTED]")
    .replace(new RegExp(REVOCABLE_KEY_SCAN_PATTERN, "g"), "[REDACTED]")
    .replace(/cogni_ag_sk_v1_[A-Za-z0-9_.-]+/g, "[REDACTED]");
  const visit = (item: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 64) throw new Error("target_response_too_complex");
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([name, child]) => [redact(name), visit(child, depth + 1)]));
    return item;
  };
  return visit(value, 0);
}
export function createServiceLinkHandlers(host: ServiceLinkHost) {
  const handle = async (id: string) =>
    z.string().uuid().safeParse(id).success ? host.handleForId(id) : null;
  return {
    async create(input: unknown): Promise<ServiceLinkAnswer> {
      const parsed = serviceLinkCreateInput.safeParse(input);
      if (!parsed.success) return answer(400, { error: "invalid_input" });
      const key = host.keyForAlias(parsed.data.targetAlias);
      if (parsed.data.replace) {
        const h = await handle(parsed.data.replace.linkId);
        if (!h || canonicalJson(h.key) !== canonicalJson(key))
          return answer(409, { error: "link_revision_conflict" });
        try {
          return answer(
            200,
            await host.requester.reenroll(
              h,
              parsed.data.replace.expectedRevision
            )
          );
        } catch (error) {
          if (error instanceof EnrollmentAdmissionError) return answer(503, { error: error.code });
          return answer(409, { error: "link_revision_conflict" });
        }
      }
      try {
        return answer(200, await host.requester.ensure(key));
      } catch (error) {
        if (error instanceof EnrollmentAdmissionError) return answer(503, { error: error.code });
        throw error;
      }
    },
    async read(
      id: string,
      resumeRevision?: number
    ): Promise<ServiceLinkAnswer> {
      const h = await handle(id);
      return h
        ? answer(200, await host.requester.advance(h, resumeRevision === undefined ? {} : { resumeRevision }))
        : answer(404, { error: "link_not_found" });
    },
    async disconnect(id: string, input: unknown): Promise<ServiceLinkAnswer> {
      const parsed = serviceLinkDisconnectInput.safeParse(input),
        h = await handle(id);
      if (!parsed.success) return answer(400, { error: "invalid_input" });
      if (!h) return answer(404, { error: "link_not_found" });
      try {
        return answer(
          200,
          await host.requester.disconnect(h, parsed.data.expectedRevision)
        );
      } catch {
        return answer(409, { error: "link_revision_conflict" });
      }
    },
    async knowledge(id: string, entryId: string): Promise<ServiceLinkAnswer> {
      const h = await handle(id);
      if (!h || !host.allowedEntries.includes(entryId))
        return answer(404, { error: "not_found" });
      const row = await host.store.read(h);
      const connectionId = row?.state.connectionId,
        credentialId = row?.state.credentialId;
      if (
        !row ||
        row.state.phase !== "connected" ||
        !connectionId ||
        !credentialId
      )
        return answer(409, { error: "service_not_connected" });
      const bearer = await host.vault.resolveServiceConnection({
        ...h,
        connectionId,
        credentialId,
      });
      if (!bearer) return answer(409, { error: "service_not_connected" });
      let res: Response;
      try {
        res = await (host.fetch ?? fetch)(
          new URL(
            entryId === "index"
              ? "/api/v1/knowledge/index"
              : `/api/v1/knowledge/${encodeURIComponent(entryId)}`,
            h.key.target.origin
          ),
          {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
            headers: {
              accept: "application/json",
              authorization: `Bearer ${bearer}`,
            },
          }
        );
        if (res.status === 401) {
          await host.store.keyRejected(h, { connectionId, credentialId });
          return answer(401, { error: "needs_reenroll" });
        }
        if (res.status === 403) return answer(403, { error: "permission_off" });
        if (!res.ok) return answer(503, { error: "target_unavailable" });
        const body = await readBoundedText(res, 1024 * 1024);
        if (!body.ok) return answer(503, { error: "target_unavailable" });
        return answer(200, redactDecodedKnowledge(JSON.parse(body.text), bearer));
      } catch {
        return answer(503, { error: "target_unavailable" });
      }
    },
  };
}
