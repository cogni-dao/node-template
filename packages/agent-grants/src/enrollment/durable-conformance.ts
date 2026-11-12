// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Fleet-shared v2 target falsifiers. Every real SQL adopter runs these same rows; no test runner is bundled. */
import type { JWK } from "jose";
import type { DurableProviderStore } from "./durable-provider";
import type { EnrollmentProof } from "./protocol";
import { acceptanceSchema, pendingKeySchema } from "./protocol";
import { openSealed } from "./seal";
export interface DurableConformanceSetup {
  store: DurableProviderStore;
  proof: EnrollmentProof;
  tokenDigest: string;
  privateJwk: JWK;
  approve(principalUserId: string): Promise<void>;
  confirm(credentialId: string): Promise<void>;
  revoke(credentialId: string): Promise<void>;
  inspect(): Promise<{
    operations: number;
    principals: number;
    asks: number;
    credentials: number;
    approvalAt: string | null;
  }>;
}
export interface DurableConformanceHarness {
  describe(name: string, run: () => void): void;
  it(name: string, run: () => Promise<void>): void;
  // biome-ignore lint/suspicious/noExplicitAny: injected test runner's assertion surface, never runtime product code
  expect(value: unknown): any;
  setup(): Promise<DurableConformanceSetup>;
}
export function runDurableEnrollmentConformance(
  h: DurableConformanceHarness
): void {
  const { describe, it, expect } = h;
  describe("shared v2 enrollment conformance", () => {
    it("lost accepted response and exact concurrent replays preserve receipt and consent", async () => {
      const f = await h.setup(),
        a = await f.store.acceptProof(f.proof, f.tokenDigest);
      if (!a.ok) throw new Error(a.reason);
      await f.approve(a.principalUserId);
      const before = await f.inspect();
      const [b, c] = await Promise.all([
        f.store.acceptProof(f.proof, f.tokenDigest),
        f.store.acceptProof(f.proof, f.tokenDigest),
      ]);
      if (!b.ok || !c.ok) throw new Error("replay failed");
      expect(b.reply.sealedAcceptance).toBe(a.reply.sealedAcceptance);
      expect(c.reply.sealedAcceptance).toBe(a.reply.sealedAcceptance);
      expect(await f.inspect()).toEqual(before);
    });
    it("concurrent polls deliver one stable sealed credential and historical confirmation spends its code", async () => {
      const f = await h.setup(),
        a = await f.store.acceptProof(f.proof, f.tokenDigest);
      if (!a.ok || !a.reply.sealedAcceptance) throw new Error("accept failed");
      const receipt = acceptanceSchema.parse(
        JSON.parse(await openSealed(a.reply.sealedAcceptance, f.privateJwk))
      );
      await f.approve(a.principalUserId);
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(receipt.deviceCode)
        )
      );
      const hash = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
      const [p, q] = await Promise.all([
        f.store.pollStable(hash),
        f.store.pollStable(hash),
      ]);
      if (!p.ok || !q.ok) throw new Error("stable poll failed");
      expect(q.credentialId).toBe(p.credentialId);
      expect(q.sealedKey).toBe(p.sealedKey);
      const opened = pendingKeySchema.parse(
        JSON.parse(await openSealed(p.sealedKey, f.privateJwk))
      );
      expect(opened.operationId).toBe(f.proof.operationId);
      expect(opened.credentialId).toBe(p.credentialId);
      expect((await f.inspect()).credentials).toBe(1);
      await f.confirm(p.credentialId);
      await f.revoke(p.credentialId);
      expect(await f.store.pollStable(hash)).toEqual({
        ok: false,
        error: "expired_token",
      });
      expect((await f.inspect()).credentials).toBe(1);
    });
    it("changed compact token/immutable digest never discloses receipt or writes domain rows", async () => {
      const f = await h.setup();
      await f.store.acceptProof(f.proof, f.tokenDigest);
      const before = await f.inspect();
      expect((await f.store.acceptProof(f.proof, "f".repeat(64))).ok).toBe(
        false
      );
      expect(
        (
          await f.store.acceptProof(
            { ...f.proof, intentDigest: "e".repeat(64) },
            f.tokenDigest
          )
        ).ok
      ).toBe(false);
      expect(await f.inspect()).toEqual(before);
    });
    it("accepted-only continuation cannot create a missing operation", async () => {
      const f = await h.setup(),
        before = await f.inspect();
      const result = await f.store.acceptProof(
        { ...f.proof, op: "continue", originalTokenDigest: f.tokenDigest },
        "0".repeat(64)
      );
      expect(result).toMatchObject({ ok: false, reason: "unknown_operation" });
      expect(await f.inspect()).toEqual(before);
    });
  });
}
