// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApplyLinkDeps,
  applyLinkAssertion,
  bindLinkedService,
  closeLinkByOwner,
  createLinkCode,
  createOrg,
  hashLinkToken,
  LINK_SCOPE,
  LinkError,
  linkClaims,
  linkedHome,
  newLinkToken,
  parseServicesClaim,
  signLinkAssertion,
} from "../src";
import { createMemoryReplayStore, createServiceAssertionSignerFromSeed, createServiceAssertionVerifier, servicePrincipalId, type ServiceAssertionSigner } from "../src/service-auth";
import { memoryLinkStore, memoryOrgStore } from "./org-store";

const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const X = "https://toks5.example.org";
const Y_NODE_ID = "node-template";

const reason = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof LinkError ? e.code : (e as { code?: string }).code ?? `other:${String(e)}`));

describe("org links", () => {
  let signer: ServiceAssertionSigner;
  let orgs: ReturnType<typeof memoryOrgStore>;
  let links: ReturnType<typeof memoryLinkStore>;
  let orgUserId: string;
  let fetchJwks: ReturnType<typeof vi.fn>;
  let replay: ReturnType<typeof createMemoryReplayStore>;

  const deps = (): ApplyLinkDeps => ({
    links,
    inTransaction: async (fn) => {
      // A throw rolls back: snapshot what the decisions can change and restore it.
      const snapshot = { codes: links.codes.map((c) => ({ ...c })), linkRows: links.links.map((l) => ({ ...l })), bindings: links.bindings.map((b) => ({ ...b })) };
      try {
        return await fn(links);
      } catch (error) {
        links.codes.splice(0, links.codes.length, ...snapshot.codes);
        links.links.splice(0, links.links.length, ...snapshot.linkRows);
        links.bindings.splice(0, links.bindings.length, ...snapshot.bindings);
        throw error;
      }
    },
    selfNodeId: Y_NODE_ID,
    replay,
    fetchJwks: fetchJwks as unknown as (uri: string) => Promise<unknown>,
  });
  const makeCode = async (origin = X) => (await createLinkCode({ orgs, links }, { actorUserId: "alice", orgUserId, origin })).code;
  const sign = (over: Partial<Parameters<typeof signLinkAssertion>[1]> = {}) =>
    signLinkAssertion(signer, { audienceNodeId: Y_NODE_ID, act: "link", orgUserId, services: ["node-ai"], ...over });

  beforeEach(async () => {
    signer = await createServiceAssertionSignerFromSeed({ issuer: X, seedHex: SEED });
    orgs = memoryOrgStore();
    links = memoryLinkStore();
    replay = createMemoryReplayStore();
    fetchJwks = vi.fn(async () => signer.jwks());
    orgUserId = (await createOrg(orgs, { creatorUserId: "alice", name: "toks5" })).orgUserId;
  });

  describe("the code (CODE_IS_HASHED_AND_SINGLE_USE)", () => {
    it("only an owner makes one; the code is stored hashed, for 15 minutes, bound to the org and origin", async () => {
      const made = await createLinkCode({ orgs, links }, { actorUserId: "alice", orgUserId, origin: X });
      expect(made.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(links.codes).toHaveLength(1);
      expect(links.codes[0]).toMatchObject({ orgUserId, origin: X, consumed: false });
      expect(links.codes[0]?.hash).not.toContain(made.code);
      expect(links.codes[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(links.codes[0]?.expiresMs).toBe(links.clock.now + 15 * 60_000);
    });

    it("a stranger gets not_found, an admin not_allowed; a bad origin, a suspended org and an already-linked origin are refused", async () => {
      orgs.addWallet("bob", `0x${"1".repeat(40)}`);
      orgs.roles.push({ userId: "bob", orgUserId, role: "admin", approvedBy: "alice", at: 0, live: true });
      expect(await reason(createLinkCode({ orgs, links }, { actorUserId: "stranger", orgUserId, origin: X }))).toBe("not_found");
      expect(await reason(createLinkCode({ orgs, links }, { actorUserId: "bob", orgUserId, origin: X }))).toBe("not_allowed");
      for (const bad of ["http://toks5.example.org", "https://toks5.example.org/path", "toks5.example.org", "https://user@toks5.example.org"])
        expect(await reason(createLinkCode({ orgs, links }, { actorUserId: "alice", orgUserId, origin: bad })), bad).toBe("invalid_origin");
      links.suspended[orgUserId] = true;
      expect(await reason(createLinkCode({ orgs, links }, { actorUserId: "alice", orgUserId, origin: X }))).toBe("org_suspended");
      links.suspended[orgUserId] = false;
      await links.insertLink({ orgUserId: "other", issuer: X, services: ["node-ai"] });
      expect(await reason(createLinkCode({ orgs, links }, { actorUserId: "alice", orgUserId, origin: X }))).toBe("issuer_already_linked");
    });
  });

  describe("a signed link", () => {
    it("burns the code, records one open link and binds each existing service principal of the issuer, including ones that appear later", async () => {
      const ai = await servicePrincipalId({ issuer: X, service: "node-ai" });
      const review = await servicePrincipalId({ issuer: X, service: "git-review" });
      links.principals.add(ai);
      const code = await makeCode();
      const result = await applyLinkAssertion(deps(), await sign({ code, services: ["node-ai", "git-review"] }));
      expect(result).toMatchObject({ ok: true, act: "link", orgUserId, issuer: X, services: ["node-ai", "git-review"], bound: 1 });
      expect(links.codes[0]?.consumed).toBe(true);
      expect(links.links).toEqual([expect.objectContaining({ orgUserId, issuer: X, open: true })]);
      expect(links.bindings).toEqual([expect.objectContaining({ subject: ai, accountOrg: orgUserId, open: true })]);
      // git-review appears later: bound when it is created, by the package's own hook.
      links.principals.add(review);
      expect(await bindLinkedService(links, { issuer: X, service: "git-review", subjectUserId: review })).toBe(true);
      expect(links.bindings.filter((b) => b.open).map((b) => b.subject).sort()).toEqual([ai, review].sort());
      // A service the link does not name, and an issuer with no link, bind nothing.
      expect(await bindLinkedService(links, { issuer: X, service: "other", subjectUserId: "x" })).toBe(false);
      expect(await bindLinkedService(links, { issuer: "https://nolink.example.org", service: "node-ai", subjectUserId: "x" })).toBe(false);
    });

    it("the keys come only from the origin's own /.well-known/jwks.json", async () => {
      await applyLinkAssertion(deps(), await sign({ code: await makeCode() }));
      expect(fetchJwks).toHaveBeenCalledTimes(1);
      expect(fetchJwks).toHaveBeenCalledWith(`${X}/.well-known/jwks.json`);
    });

    it("a link with a used code, an expired code, an unknown code or another origin's code creates nothing and answers one code", async () => {
      const used = await makeCode();
      expect((await applyLinkAssertion(deps(), await sign({ code: used }))).ok).toBe(true);
      await links.closeLink({ linkId: links.links[0]?.id as string, closedBy: "alice" });
      expect(await applyLinkAssertion(deps(), await sign({ code: used }))).toMatchObject({ ok: false, code: "link_code_invalid" });
      const stale = await makeCode();
      links.clock.now += 16 * 60_000;
      expect(await applyLinkAssertion(deps(), await sign({ code: stale }))).toMatchObject({ ok: false, code: "link_code_invalid" });
      expect(await applyLinkAssertion(deps(), await sign({ code: "A".repeat(43) }))).toMatchObject({ ok: false, code: "link_code_invalid" });
      links.clock.now = 1_000_000;
      const forOther = await makeCode("https://other.example.org");
      expect(await applyLinkAssertion(deps(), await sign({ code: forOther }))).toMatchObject({ ok: false, code: "link_code_invalid" });
      expect(links.links.filter((l) => l.open)).toEqual([]);
    });

    it("a code made for one org cannot link another org: the signed org claim must match", async () => {
      const code = await makeCode();
      expect(await applyLinkAssertion(deps(), await sign({ code, orgUserId: "some-other-org" }))).toMatchObject({ ok: false, code: "link_code_invalid" });
      expect(links.codes[0]?.consumed).toBe(false);
    });

    it("a link with no signature of the origin creates nothing: wrong key, tampered claims and a wrong audience are refused, and the code survives", async () => {
      const code = await makeCode();
      const thief = await createServiceAssertionSignerFromSeed({ issuer: X, seedHex: "11".repeat(32) });
      expect(await applyLinkAssertion(deps(), await signLinkAssertion(thief, { audienceNodeId: Y_NODE_ID, act: "link", orgUserId, code, services: ["node-ai"] }))).toMatchObject({ ok: false, code: "invalid_assertion" });
      const good = await sign({ code });
      const [h, p, s] = good.split(".") as [string, string, string];
      const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
      const forged = btoa(JSON.stringify({ ...claims, services: "node-ai admin" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(await applyLinkAssertion(deps(), `${h}.${forged}.${s}`)).toMatchObject({ ok: false, code: "invalid_assertion" });
      expect(await applyLinkAssertion(deps(), await sign({ code, audienceNodeId: "another-node" }))).toMatchObject({ ok: false, code: "invalid_assertion" });
      expect(links.codes[0]?.consumed).toBe(false);
      expect(links.links).toEqual([]);
      // The honest signature still works.
      expect((await applyLinkAssertion(deps(), good)).ok).toBe(true);
    });

    it("an ordinary assertion (a run's service, not node-connect) is no link", async () => {
      const code = await makeCode();
      const run = await signer.sign({ service: "node-ai", audienceNodeId: Y_NODE_ID, scope: LINK_SCOPE, claims: linkClaims({ act: "link", orgUserId, code, services: ["node-ai"] }) });
      expect(await applyLinkAssertion(deps(), run)).toMatchObject({ ok: false, code: "invalid_assertion" });
      expect(links.links).toEqual([]);
    });

    it("a replayed assertion is refused and a second origin link is issuer_already_linked", async () => {
      const code = await makeCode();
      const token = await sign({ code });
      expect((await applyLinkAssertion(deps(), token)).ok).toBe(true);
      expect(await applyLinkAssertion(deps(), token)).toMatchObject({ ok: false, code: "link_code_invalid" });
      // A fresh code and fresh signature for the same issuer on a second org.
      const second = (await createOrg(orgs, { creatorUserId: "alice", name: "second" })).orgUserId;
      const secondCode = newLinkToken();
      await links.createCode({ orgUserId: second, origin: X, codeHash: await hashLinkToken(secondCode), createdBy: "alice", ttlMinutes: 15, maxOpen: 10 });
      const result = await applyLinkAssertion(deps(), await sign({ code: secondCode, orgUserId: second }));
      expect(result).toMatchObject({ ok: false, code: "issuer_already_linked" });
      // The refused attempt did not burn the code.
      expect(links.codes.find((c) => c.orgUserId === second)?.consumed).toBe(false);
    });

    it("a suspended org links nothing, and a key-fetch outage is its own refusal", async () => {
      const code = await makeCode();
      links.suspended[orgUserId] = true;
      expect(await applyLinkAssertion(deps(), await sign({ code }))).toMatchObject({ ok: false, code: "org_suspended" });
      links.suspended[orgUserId] = false;
      fetchJwks.mockRejectedValueOnce(new Error("down"));
      expect(await applyLinkAssertion(deps(), await sign({ code }))).toMatchObject({ ok: false, code: "jwks_unavailable" });
    });

    it("a replay-store failure is thrown, never a pass", async () => {
      const code = await makeCode();
      const broken = { ...deps(), replay: { seen: async () => Promise.reject(new Error("db down")) } };
      await expect(applyLinkAssertion(broken, await sign({ code }))).rejects.toThrow("db down");
    });
  });

  describe("unlink, from either side", () => {
    const linked = async () => {
      const ai = await servicePrincipalId({ issuer: X, service: "node-ai" });
      links.principals.add(ai);
      await applyLinkAssertion(deps(), await sign({ code: await makeCode() }));
      return ai;
    };

    it("the owner unlinks: the link and its bindings close; an admin and a stranger cannot", async () => {
      await linked();
      const linkId = links.links[0]?.id as string;
      orgs.roles.push({ userId: "bob", orgUserId, role: "admin", approvedBy: "alice", at: 0, live: true });
      const base = { orgs, inTransaction: async <T>(fn: (l: typeof links) => Promise<T>) => fn(links) };
      expect(await reason(closeLinkByOwner(base, { actorUserId: "bob", orgUserId, linkId }))).toBe("not_allowed");
      expect(await reason(closeLinkByOwner(base, { actorUserId: "stranger", orgUserId, linkId }))).toBe("not_found");
      expect(await closeLinkByOwner(base, { actorUserId: "alice", orgUserId, linkId })).toMatchObject({ issuer: X, closedBindings: 1 });
      expect(links.links[0]).toMatchObject({ open: false, closedBy: "alice" });
      expect(links.bindings.every((b) => !b.open)).toBe(true);
      expect(await reason(closeLinkByOwner(base, { actorUserId: "alice", orgUserId, linkId }))).toBe("link_not_found");
      expect(await linkedHome(links, X)).toBeNull();
    });

    it("the other node unlinks by signing act unlink for the org; a signature for another org or with no open link refuses", async () => {
      await linked();
      expect(await applyLinkAssertion(deps(), await sign({ act: "unlink", orgUserId: "some-other-org", services: undefined }))).toMatchObject({ ok: false, code: "no_open_link" });
      const result = await applyLinkAssertion(deps(), await sign({ act: "unlink", services: undefined }));
      expect(result).toMatchObject({ ok: true, act: "unlink", orgUserId, issuer: X, closedBindings: 1 });
      expect(links.links[0]?.open).toBe(false);
      expect(links.bindings.every((b) => !b.open)).toBe(true);
      expect(await applyLinkAssertion(deps(), await sign({ act: "unlink", services: undefined }))).toMatchObject({ ok: false, code: "no_open_link" });
    });

    it("an unlink signed by a thief is refused and closes nothing; re-linking after an unlink works", async () => {
      await linked();
      const thief = await createServiceAssertionSignerFromSeed({ issuer: X, seedHex: "22".repeat(32) });
      expect(await applyLinkAssertion(deps(), await signLinkAssertion(thief, { audienceNodeId: Y_NODE_ID, act: "unlink", orgUserId }))).toMatchObject({ ok: false, code: "invalid_assertion" });
      expect(links.links[0]?.open).toBe(true);
      await applyLinkAssertion(deps(), await sign({ act: "unlink", services: undefined }));
      expect((await applyLinkAssertion(deps(), await sign({ code: await makeCode() }))).ok).toBe(true);
      expect(links.links.filter((l) => l.open)).toHaveLength(1);
    });
  });

  describe("the linked issuer's later calls", () => {
    it("the verifier trusts an issuer with an open link at run time, for the link's services only, and stops when it closes", async () => {
      await applyLinkAssertion(deps(), await sign({ code: await makeCode() }));
      const verifier = createServiceAssertionVerifier({
        selfNodeId: Y_NODE_ID,
        trustedHomes: [],
        resolveHome: (issuer) => linkedHome(links, issuer),
        fetchJwks: async () => signer.jwks(),
        replay: createMemoryReplayStore(),
      });
      const call = (service: string) => signer.sign({ service, audienceNodeId: Y_NODE_ID, scope: "knowledge:read" });
      expect(await verifier.verify(await call("node-ai"))).toMatchObject({ ok: true, issuer: X, service: "node-ai" });
      expect(await verifier.verify(await call("git-review"))).toMatchObject({ ok: false, code: "service_not_allowed" });
      await links.closeLink({ linkId: links.links[0]?.id as string, closedBy: "alice" });
      expect(await verifier.verify(await call("node-ai"))).toMatchObject({ ok: false, code: "untrusted_issuer" });
    });
  });

  it("parseServicesClaim keeps slugs, refuses node-connect, an empty list and more than eight services", () => {
    expect(parseServicesClaim("node-ai git-review node-ai")).toEqual(["node-ai", "git-review"]);
    for (const bad of ["", "node-connect", "node-ai node-connect", "Bad Slug", 5, "a b c d e f g h i"]) expect(parseServicesClaim(bad), String(bad)).toBeNull();
  });
});
