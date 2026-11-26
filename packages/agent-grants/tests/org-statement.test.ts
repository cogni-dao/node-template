// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/org-statement`
 * Purpose: The org statement is the only source of an org's admins, so each test names a way a node could be made to trust the wrong list: a statement signed by a key the origin does
 *   not publish, one that outlives ten minutes, one that speaks for another origin, an older one replayed after a newer one, a cache that outlives five minutes, and an unreadable one
 *   that must lapse admin roles instead of keeping the last list.
 * Scope: Pure over injected fetches and a fake clock. No network, no database.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  createOrgStatementIssuer,
  createOrgStatementOwnerSource,
  ORG_JWKS_PATH,
  fetchOrgDocument,
  ORG_STATEMENT_PATH,
  type OrgFacts,
  type OrgFetch,
  verifyOrgStatement,
} from "../src/org-statement";
import { OwnerSourceUnavailableError } from "../src/orgs";
import { createServiceAssertionSignerFromSeed } from "../src/service-auth";

const ORIGIN = "https://toks5.example.com";
const SEED_A = "11".repeat(32);
const SEED_B = "22".repeat(32);
const ADMIN = "0x00000000000000000000000000000000000000a1";
const ADMIN_2 = "0x00000000000000000000000000000000000000a2";
const facts = (admins: string[] = [ADMIN]): OrgFacts => ({ dao: null, admins, services: ["node-ai"], commit: "abc1234" });

/** An origin that serves `statement()` and the JWKS of `jwksSigner`. */
async function origin(opts: { issueSeed?: string; jwksSeed?: string; clock: { ms: number }; admins?: string[]; statementOrigin?: string; version?: number }) {
  const issuing = await createServiceAssertionSignerFromSeed({ issuer: ORIGIN, seedHex: opts.issueSeed ?? SEED_A, now: () => opts.clock.ms });
  const publishing = await createServiceAssertionSignerFromSeed({ issuer: ORIGIN, seedHex: opts.jwksSeed ?? opts.issueSeed ?? SEED_A, now: () => opts.clock.ms });
  let admins = opts.admins ?? [ADMIN];
  let version = opts.version;
  const issuer = () =>
    createOrgStatementIssuer({ signer: issuing, origin: opts.statementOrigin ?? ORIGIN, nodeId: "toks5", facts: () => facts(admins), version: version ?? Math.floor(opts.clock.ms / 1000), now: () => opts.clock.ms });
  let fetches = 0;
  let down = false;
  const fetch: OrgFetch = async (_origin, path) => {
    fetches += 1;
    if (down) throw new Error("down");
    return path === ORG_STATEMENT_PATH ? issuer().statement() : path === ORG_JWKS_PATH ? JSON.stringify(publishing.jwks()) : Promise.reject(new Error("path"));
  };
  return { fetch, setVersion: (next: number) => (version = next), setAdmins: (next: string[]) => (admins = next), fetches: () => fetches, setDown: (v: boolean) => (down = v) };
}

describe("verifyOrgStatement", () => {
  it("accepts a statement signed by the key its own origin publishes", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock });
    const result = await verifyOrgStatement({ origin: ORIGIN, fetch: o.fetch, now: () => clock.ms });
    expect(result).toMatchObject({ ok: true, statement: { origin: ORIGIN, nodeId: "toks5", admins: [ADMIN], services: ["node-ai"], version: 1_800_000_000 } });
  });

  it("refuses a statement signed by a key the origin does not publish (a forged admin list)", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock, issueSeed: SEED_B, jwksSeed: SEED_A });
    // Same kid space is impossible: the forger's kid is its own thumbprint, absent from the published set.
    expect(await verifyOrgStatement({ origin: ORIGIN, fetch: o.fetch, now: () => clock.ms })).toEqual({ ok: false, code: "bad_signature" });
  });

  it("refuses a statement that speaks for another origin", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock, statementOrigin: "https://other.example.com" });
    expect(await verifyOrgStatement({ origin: ORIGIN, fetch: o.fetch, now: () => clock.ms })).toEqual({ ok: false, code: "wrong_origin" });
  });

  it("refuses a statement whose version runs ahead of its own issue time, so one signed statement cannot pin the version floor above every honest one", async () => {
    const signer = await createServiceAssertionSignerFromSeed({ issuer: ORIGIN, seedHex: SEED_A });
    const claims = (version: number) => ({ iss: ORIGIN, sub: "toks5", origin: ORIGIN, dao: null, admins: [ADMIN], services: [], version, commit: null, iat: 1_800_000_000, exp: 1_800_000_300 });
    const verify = async (version: number) => {
      const token = await signer.signClaims(claims(version), "cogni-org+jwt");
      return verifyOrgStatement({ origin: ORIGIN, fetch: async (_o, p) => (p === ORG_STATEMENT_PATH ? token : JSON.stringify(signer.jwks())), now: () => 1_800_000_010_000 });
    };
    expect(await verify(1_800_000_000 + 60)).toMatchObject({ ok: true });
    expect(await verify(1_800_000_000 + 61)).toEqual({ ok: false, code: "malformed" });
  });

  it("refuses an expired statement and one that lives longer than ten minutes", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock });
    const token = await o.fetch(ORIGIN, ORG_STATEMENT_PATH);
    clock.ms += 400_000;
    expect(await verifyOrgStatement({ origin: ORIGIN, fetch: async (_o, p) => (p === ORG_STATEMENT_PATH ? token : o.fetch(ORIGIN, p)), now: () => clock.ms })).toEqual({ ok: false, code: "expired" });

    const signer = await createServiceAssertionSignerFromSeed({ issuer: ORIGIN, seedHex: SEED_A });
    const longLived = await signer.signClaims(
      { iss: ORIGIN, sub: "toks5", origin: ORIGIN, dao: null, admins: [ADMIN], services: [], version: 1, commit: null, iat: 1_800_000_000, exp: 1_800_000_000 + 3600 },
      "cogni-org+jwt"
    );
    const fresh = { ms: 1_800_000_010_000 };
    const result = await verifyOrgStatement({
      origin: ORIGIN,
      fetch: async (_o, p) => (p === ORG_STATEMENT_PATH ? longLived : JSON.stringify(signer.jwks())),
      now: () => fresh.ms,
    });
    expect(result).toEqual({ ok: false, code: "malformed" });
  });

  it("is unreachable, never an empty admin list, when the origin does not answer", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock });
    o.setDown(true);
    expect(await verifyOrgStatement({ origin: ORIGIN, fetch: o.fetch, now: () => clock.ms })).toEqual({ ok: false, code: "unreachable" });
  });
});

describe("fetchOrgDocument", () => {
  it("cancels the body of a refused answer, so a slow or huge error page does not hold the connection", async () => {
    const cancel = vi.fn(async () => undefined);
    const refused = { ok: false, status: 503, body: { cancel } } as unknown as Response;
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(refused);
    try {
      await expect(fetchOrgDocument(ORIGIN, ORG_STATEMENT_PATH)).rejects.toThrow("status 503");
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the org-statement owner source", () => {
  const wallets = new Map([[ADMIN, "user-1"], [ADMIN_2, "user-2"]]);
  const usersForWallets = async (list: string[]) => list.flatMap((w) => (wallets.has(w) ? [wallets.get(w) as string] : []));
  const source = { kind: "org-statement", ref: ORIGIN } as const;

  it("reads again after five minutes, so a removed approver loses admin within the window", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock, admins: [ADMIN, ADMIN_2] });
    const owners = createOrgStatementOwnerSource({ usersForWallets, fetch: o.fetch, now: () => clock.ms });
    expect([...(await owners.owners(source))].sort()).toEqual(["user-1", "user-2"]);
    o.setAdmins([ADMIN]);
    clock.ms += 200_000;
    expect([...(await owners.owners(source))].sort()).toEqual(["user-1", "user-2"]);
    expect(o.fetches()).toBe(2);
    clock.ms += 101_000;
    expect(await owners.owners(source)).toEqual(["user-1"]);
    expect(o.fetches()).toBe(4);
  });

  it("signs the BUILD's version, not the signing second, and refuses an older build's statement (a replica of the previous deploy) that still lists an approver the newer build removed", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const newer = 1_799_999_000;
    const older = 1_799_000_000;
    const o = await origin({ clock, admins: [ADMIN], version: newer });
    const verified = await verifyOrgStatement({ origin: ORIGIN, fetch: o.fetch, now: () => clock.ms });
    expect(verified.ok && verified.statement.version).toBe(newer);
    // ttlMs 0: every read is a fresh one, as if two replicas answered in turn.
    const owners = createOrgStatementOwnerSource({ usersForWallets, fetch: o.fetch, now: () => clock.ms, ttlMs: 0 });
    expect(await owners.owners(source)).toEqual(["user-1"]);
    o.setVersion(older);
    o.setAdmins([ADMIN, ADMIN_2]);
    await expect(owners.owners(source)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    o.setVersion(newer);
    o.setAdmins([ADMIN]);
    expect(await owners.owners(source)).toEqual(["user-1"]);
  });

  it("refuses a statement at the SAME version with other facts (facts are constant per build, so it is another build's), and accepts the same facts again", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock, admins: [ADMIN, ADMIN_2], version: 1_799_999_000 });
    const owners = createOrgStatementOwnerSource({ usersForWallets, fetch: o.fetch, now: () => clock.ms, ttlMs: 0 });
    expect([...(await owners.owners(source))].sort()).toEqual(["user-1", "user-2"]);
    // The same build answered again (another replica, same facts): fine.
    expect([...(await owners.owners(source))].sort()).toEqual(["user-1", "user-2"]);
    // Same version, a different admin list: stale.
    o.setAdmins([ADMIN]);
    await expect(owners.owners(source)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("accepts a statement below the held version that says exactly the held facts (another replica signed it earlier), and refuses one that says anything else", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock, admins: [ADMIN, ADMIN_2] });
    const heldFloor = async () => 1_800_000_100;
    const same = createOrgStatementOwnerSource({ usersForWallets, fetch: o.fetch, now: () => clock.ms, heldVersion: heldFloor, holdsFacts: async () => true });
    expect([...(await same.owners(source))].sort()).toEqual(["user-1", "user-2"]);
    const changed = createOrgStatementOwnerSource({ usersForWallets, fetch: o.fetch, now: () => clock.ms, heldVersion: heldFloor, holdsFacts: async () => false });
    await expect(changed.owners(source)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("remembers an unreadable origin for a short while, so a page of orgs does not refetch a dead origin per row", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock });
    o.setDown(true);
    const owners = createOrgStatementOwnerSource({ usersForWallets, fetch: o.fetch, now: () => clock.ms });
    await expect(owners.owners(source)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    const afterFirst = o.fetches();
    await expect(owners.owners(source)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
    expect(o.fetches()).toBe(afterFirst);
    o.setDown(false);
    clock.ms += 16_000;
    expect(await owners.owners(source)).toEqual(["user-1"]);
  });

  it("refuses a statement older than the version already held, so a replayed list cannot take admin back", async () => {
    const clock = { ms: 1_800_000_100_000 };
    const o = await origin({ clock, admins: [ADMIN, ADMIN_2] });
    const owners = createOrgStatementOwnerSource({ usersForWallets, fetch: o.fetch, heldVersion: async () => 1_800_000_200, now: () => clock.ms });
    await expect(owners.owners(source)).rejects.toMatchObject({ name: "OwnerSourceUnavailableError", reason: "stale" });
  });

  it("lapses admin when the statement cannot be read, instead of keeping the last list", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock });
    const owners = createOrgStatementOwnerSource({ usersForWallets, fetch: o.fetch, now: () => clock.ms });
    await owners.owners(source);
    o.setDown(true);
    clock.ms += 301_000;
    await expect(owners.owners(source)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
  });

  it("serves an admin list only together with its history row: when recording a refresh fails the read fails closed and the failure is reported", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock, admins: [ADMIN, ADMIN_2] });
    const reported: unknown[] = [];
    const owners = createOrgStatementOwnerSource({
      usersForWallets,
      fetch: o.fetch,
      now: () => clock.ms,
      onVerified: async () => {
        throw new Error("db down");
      },
      onRefreshError: (error) => reported.push(error),
    });
    await expect(owners.owners(source)).rejects.toMatchObject({ name: "OwnerSourceUnavailableError", reason: "record_failed" });
    expect(reported).toHaveLength(1);
  });

  it("an older statement than the one held is never served or cached, so it can never restore an admin the newer one removed", async () => {
    const clock = { ms: 1_800_000_000_000 };
    // The origin still serves the OLD list (both approvers); the database already holds a newer statement that removed one, so recording the old one is a no-op that says `stale`.
    const o = await origin({ clock, admins: [ADMIN, ADMIN_2] });
    const owners = createOrgStatementOwnerSource({
      usersForWallets,
      fetch: o.fetch,
      now: () => clock.ms,
      negativeTtlMs: 0,
      onVerified: async () => {
        throw new OwnerSourceUnavailableError("stale");
      },
    });
    await expect(owners.owners(source)).rejects.toMatchObject({ name: "OwnerSourceUnavailableError", reason: "stale" });
    const first = o.fetches();
    await expect(owners.owners(source)).rejects.toMatchObject({ reason: "stale" });
    // Not cached: the second call read the origin again and was refused again.
    expect(o.fetches()).toBeGreaterThan(first);
  });

  it("maps wallets to users on every call, so a person who signs in is an admin at once", async () => {
    const clock = { ms: 1_800_000_000_000 };
    const o = await origin({ clock, admins: [ADMIN, ADMIN_2] });
    const signedIn = new Map<string, string>([[ADMIN, "user-1"]]);
    const owners = createOrgStatementOwnerSource({ usersForWallets: async (l) => l.flatMap((w) => (signedIn.has(w) ? [signedIn.get(w) as string] : [])), fetch: o.fetch, now: () => clock.ms });
    expect(await owners.owners(source)).toEqual(["user-1"]);
    signedIn.set(ADMIN_2, "user-2");
    expect([...(await owners.owners(source))].sort()).toEqual(["user-1", "user-2"]);
    expect(o.fetches()).toBe(2);
  });
});
