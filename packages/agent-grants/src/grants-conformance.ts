// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/grants-conformance`
 * Purpose: The grant conformance suite (SUITE_GATES_RELEASE) for the one grant row, node and account alike. Every node that adopts
 *   `@cogni-dao/agent-grants` runs these rows over ITS store, so one definition of "a correct grant store" gates every adopter and the release.
 * Scope: Test rows only. The package imports no test runner: the caller passes `describe`, `it` and `expect` (vitest) and a harness that
 *   prepares users and accounts, moves the clock of a row, and breaks the store. The package runs the rows over a memory store; a node
 *   runs them over real SQL (`app/tests/component/db/agent-grants-conformance.int.test.ts`).
 * Invariants: Rows assert behavior through the package functions (`requestAccess`, `approveAccountAsk`, `authorizeAccount`, ...), never store internals.
 *   The "revoked key" row of the standard lives in the credential suite (`runCredentialConformance`): a revoked key never reaches a grant check.
 * Side-effects: whatever the harness does
 * @public
 */

import { APPROVAL_FRAGMENT_KEY, hashLinkToken } from "./approval";
import { authorizeAccount } from "./authorize";
import {
  approveAccountAsk,
  denyAccountAsk,
  grantInternalOnAccount,
  grantRole,
  listOwnAccess,
  previewAsk,
  requestAccess,
  revokeAccountRow,
} from "./roles";
import type { AgentGrantsStore } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: structural match for vitest's `expect`
type Expect = (value: unknown) => any;

export interface GrantConformanceHarness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
  expect: Expect;
  /**
   * A fresh store. `owners` are people who each own one billing account, `agents` are outside agents, `internal` are this node's AI (their name is
   * the slug). `ids` maps every name to its user id; `accounts` maps each owner to the account they own.
   */
  setup(spec: { owners: string[]; agents: string[]; internal: string[] }): Promise<{
    store: AgentGrantsStore;
    ids: Record<string, string>;
    accounts: Record<string, string>;
  }>;
  /** End the live account row of (principal, scope) in the past, keeping every CHECK of the table true. */
  expireGrant(principalUserId: string, scope: string): Promise<void>;
  /** End the one-time link of the pending row of (principal, scope) in the past. */
  expireLink(principalUserId: string, scope: string): Promise<void>;
  /** A store whose every call throws, for the outage rows. */
  broken(): AgentGrantsStore;
}

const SCOPE = "account:read";
const NODE_SCOPE = "work_item:transition";
const declaredScopes = [SCOPE, NODE_SCOPE];
const scopeKinds = { [SCOPE]: "account", [NODE_SCOPE]: "node" } as const;
const ask = (store: AgentGrantsStore, principalUserId: string, scope = SCOPE) =>
  requestAccess(store, { principalUserId, scope, declaredScopes, askableScopes: declaredScopes, scopeKinds });
const tokenOf = (path: string | undefined): string => {
  const token = path?.split(`#${APPROVAL_FRAGMENT_KEY}=`)[1];
  if (!token) throw new Error(`no approval token in ${String(path)}`);
  return token;
};
const asker = async (store: AgentGrantsStore, id: string, scope = SCOPE) => tokenOf((await ask(store, id, scope)).approvalPath);
const person = (userId: string, admin: object | null = null) => ({ userId, admin });

export function runGrantConformance(h: GrantConformanceHarness): void {
  const { describe, it, expect } = h;
  const spec = { owners: ["alice", "bob"], agents: ["agent", "other"], internal: ["node-ai"] };

  describe("grant conformance: account access (owner, live, expired, revoked, wrong scope, foreign, missing)", () => {
    it("the owner reads their own account; a stranger and a missing grant get null", async () => {
      const { store, ids, accounts } = await h.setup(spec);
      const read = (callerUserId: string, via: "bearer" | "session", accountId: string, scope = SCOPE) =>
        authorizeAccount(store, { callerUserId, via, scope, accountId });
      expect(await read(ids.alice as string, "session", accounts.alice as string)).toBe("owner");
      expect(await read(ids.bob as string, "session", accounts.alice as string)).toBeNull();
      expect(await read(ids.agent as string, "bearer", accounts.alice as string)).toBeNull(); // missing grant
      expect(await read(ids.agent as string, "bearer", "no-such-account")).toBeNull();
    });

    it("a live grant for this agent, this scope and this account is delegated; the same agent on another account is null", async () => {
      const { store, ids, accounts } = await h.setup(spec);
      const token = await asker(store, ids.agent as string);
      expect(await approveAccountAsk(store, { me: person(ids.alice as string), token, days: 7 })).toEqual({ approved: true });
      const read = (callerUserId: string, accountId: string, scope = SCOPE) =>
        authorizeAccount(store, { callerUserId, via: "bearer", scope, accountId });
      expect(await read(ids.agent as string, accounts.alice as string)).toBe("delegated");
      expect(await store.hasLiveAccountGrant(ids.agent as string, SCOPE, accounts.alice as string)).toBe(true);
      expect(await read(ids.agent as string, accounts.bob as string)).toBeNull(); // foreign account
      expect(await read(ids.other as string, accounts.alice as string)).toBeNull(); // another agent
      expect(await read(ids.agent as string, accounts.alice as string, "account:write")).toBeNull(); // wrong scope
      // A person's session never takes the delegated path.
      expect(await authorizeAccount(store, { callerUserId: ids.agent as string, via: "session", scope: SCOPE, accountId: accounts.alice as string })).toBeNull();
    });

    it("an expired grant is null and reads as expired; it is closed before the next ask so the AI can ask again", async () => {
      const { store, ids, accounts } = await h.setup(spec);
      await approveAccountAsk(store, { me: person(ids.alice as string), token: await asker(store, ids.agent as string), days: 1 });
      await h.expireGrant(ids.agent as string, SCOPE);
      expect(await store.hasLiveAccountGrant(ids.agent as string, SCOPE, accounts.alice as string)).toBe(false);
      expect(await authorizeAccount(store, { callerUserId: ids.agent as string, via: "bearer", scope: SCOPE, accountId: accounts.alice as string })).toBeNull();
      expect((await listOwnAccess(store, ids.agent as string)).find((r) => r.scope === SCOPE)).toMatchObject({ state: "expired", accountId: accounts.alice });
      expect(await store.liveAccountScopes(ids.agent as string, [SCOPE], accounts.alice as string)).toEqual([]);
      // R14: expired is a state; the ask closes the old row, writes a new pending one, and still reads as pending for the new row.
      const again = await ask(store, ids.agent as string);
      expect(again).toMatchObject({ state: "pending", created: true });
      expect((await listOwnAccess(store, ids.agent as string)).map((r) => r.state).sort()).toEqual(["expired", "pending"]);
    });

    it("a revoked grant is null from the next call, and only the owner of the account can revoke it", async () => {
      const { store, ids, accounts } = await h.setup(spec);
      await approveAccountAsk(store, { me: person(ids.alice as string), token: await asker(store, ids.agent as string), days: 7 });
      const rows = await store.listAccountRoleRows(accounts.alice as string, 10);
      expect(rows).toHaveLength(1);
      const rowId = rows[0]?.rowId as string;
      // A foreign person, an admin who owns another account, and a node-admin session all see nothing to revoke.
      expect(await revokeAccountRow(store, { me: person(ids.bob as string), rowId })).toEqual({ revoked: false });
      expect(await revokeAccountRow(store, { me: person(ids.bob as string, {}), rowId })).toEqual({ revoked: false });
      expect(await store.hasLiveAccountGrant(ids.agent as string, SCOPE, accounts.alice as string)).toBe(true);
      expect(await revokeAccountRow(store, { me: person(ids.alice as string), rowId })).toEqual({ revoked: true });
      expect(await store.hasLiveAccountGrant(ids.agent as string, SCOPE, accounts.alice as string)).toBe(false);
      expect(await authorizeAccount(store, { callerUserId: ids.agent as string, via: "bearer", scope: SCOPE, accountId: accounts.alice as string })).toBeNull();
      expect((await listOwnAccess(store, ids.agent as string)).find((r) => r.scope === SCOPE)?.state).toBe("revoked");
    });

    it("a store outage throws; it never reads as access", async () => {
      await expect(authorizeAccount(h.broken(), { callerUserId: "a", via: "bearer", scope: SCOPE, accountId: "x" })).rejects.toBeInstanceOf(Error);
    });
  });

  describe("grant conformance: the one gate and the one link", () => {
    it("the account owner is the whole approval: an admin session with no account of its own cannot decide an account ask, and a node-admin has no veto", async () => {
      const { store, ids } = await h.setup({ ...spec, owners: ["alice"] });
      const token = await asker(store, ids.agent as string);
      // An admin who owns no account is refused. (Admin status is the presence of `admin`; it is no use for an account row.)
      await expect(approveAccountAsk(store, { me: person(ids.other as string, {}), token })).rejects.toMatchObject({ code: "not_allowed" });
      expect(await store.findPendingByLink({ linkHash: await hashLinkToken(token), resource: "account" })).not.toBeNull();
      // The owner decides alone, with no admin session.
      expect(await approveAccountAsk(store, { me: person(ids.alice as string), token })).toEqual({ approved: true });
    });

    it("a node row is decided only with an admin session; an account owner is not an admin", async () => {
      const { store, ids } = await h.setup(spec);
      await ask(store, ids.agent as string, NODE_SCOPE);
      await expect(grantRole(store, { principalUserId: ids.agent as string, scope: NODE_SCOPE, me: person(ids.alice as string), declaredScopes })).rejects.toMatchObject({ code: "not_allowed" });
      expect(await store.hasLiveRole(ids.agent as string, NODE_SCOPE)).toBe(false);
      await grantRole(store, { principalUserId: ids.agent as string, scope: NODE_SCOPE, me: person(ids.bob as string, {}), declaredScopes });
      expect(await store.hasLiveRole(ids.agent as string, NODE_SCOPE)).toBe(true);
    });

    it("the two kinds never cross: a node token on the account page, and an account token on the admin page, are one non-disclosing null; a decide by the wrong kind is refused", async () => {
      const { store, ids } = await h.setup(spec);
      const accountToken = await asker(store, ids.agent as string);
      const nodeToken = await asker(store, ids.other as string, NODE_SCOPE);
      expect(await previewAsk(store, { token: nodeToken, resource: "account" })).toBeNull();
      expect(await previewAsk(store, { token: accountToken, resource: "node" })).toBeNull();
      expect(await previewAsk(store, { token: accountToken, resource: "account" })).toMatchObject({ principalUserId: ids.agent, scope: SCOPE });
      expect(await approveAccountAsk(store, { me: person(ids.alice as string), token: nodeToken })).toEqual({ approved: false });
      expect(await store.hasLiveRole(ids.other as string, NODE_SCOPE)).toBe(false);
      expect(await previewAsk(store, { token: "not-a-token", resource: "account" })).toBeNull();
    });

    it("a link is one-time: used, expired and unknown tokens are the same null; a re-ask rotates it", async () => {
      const { store, ids } = await h.setup(spec);
      const first = await asker(store, ids.agent as string);
      const second = await asker(store, ids.agent as string); // a re-ask on the pending row rotates the token
      expect(second).not.toBe(first);
      expect(await previewAsk(store, { token: first, resource: "account" })).toBeNull();
      expect(await approveAccountAsk(store, { me: person(ids.alice as string), token: first })).toEqual({ approved: false });
      expect(await approveAccountAsk(store, { me: person(ids.alice as string), token: second, days: 1 })).toEqual({ approved: true });
      expect(await approveAccountAsk(store, { me: person(ids.bob as string), token: second })).toEqual({ approved: false }); // used up
      expect(await previewAsk(store, { token: second, resource: "account" })).toBeNull();
      // An ask whose link ended in the past is null until it is asked again.
      await ask(store, ids.other as string);
      await h.expireLink(ids.other as string, SCOPE);
      expect(await asker(store, ids.other as string)).toMatch(/^[\w-]{43}$/);
    });

    it("an ended link does not preview or decide", async () => {
      const { store, ids } = await h.setup(spec);
      const token = await asker(store, ids.agent as string);
      await h.expireLink(ids.agent as string, SCOPE);
      expect(await previewAsk(store, { token, resource: "account" })).toBeNull();
      expect(await approveAccountAsk(store, { me: person(ids.alice as string), token })).toEqual({ approved: false });
    });

    it("NO_SELF_APPROVAL: an agent that owns an account cannot decide its own ask", async () => {
      const { store, ids } = await h.setup({ owners: ["alice"], agents: [], internal: [] });
      const token = await asker(store, ids.alice as string); // alice asks as a principal, and owns an account
      await expect(approveAccountAsk(store, { me: person(ids.alice as string), token })).rejects.toMatchObject({ code: "not_allowed" });
      expect(await store.hasLiveAccountGrant(ids.alice as string, SCOPE, (await store.accountOf(ids.alice as string)) as string)).toBe(false);
    });

    it("the owner's no (the x) needs the token, closes the row, and the agent sees denied", async () => {
      const { store, ids } = await h.setup(spec);
      const token = await asker(store, ids.agent as string);
      expect(await denyAccountAsk(store, { me: person(ids.bob as string), token })).toEqual({ denied: true });
      expect(await approveAccountAsk(store, { me: person(ids.alice as string), token })).toEqual({ approved: false });
      expect((await listOwnAccess(store, ids.agent as string)).find((r) => r.scope === SCOPE)?.state).toBe("denied");
    });

    it("the owner picks 1, 7 or 30 days; nothing else", async () => {
      const { store, ids } = await h.setup(spec);
      const token = await asker(store, ids.agent as string);
      await expect(approveAccountAsk(store, { me: person(ids.alice as string), token, days: 31 })).rejects.toMatchObject({ code: "invalid_days" });
      await expect(approveAccountAsk(store, { me: person(ids.alice as string), token, days: 0 })).rejects.toMatchObject({ code: "invalid_days" });
      expect(await approveAccountAsk(store, { me: person(ids.alice as string), token, days: 30 })).toEqual({ approved: true });
    });
  });

  describe("grant conformance: two starts, one row", () => {
    it("direct On works for this node's AI on the owner's own account, and is refused for an outside agent", async () => {
      const { store, ids, accounts } = await h.setup(spec);
      expect(await grantInternalOnAccount(store, { me: person(ids.alice as string), principalUserId: ids["node-ai"] as string, scope: SCOPE, declaredScopes })).toEqual({
        principalUserId: ids["node-ai"],
        created: true,
      });
      expect(await store.hasLiveAccountGrant(ids["node-ai"] as string, SCOPE, accounts.alice as string)).toBe(true);
      // The node's AI holds only the account row: no node row exists or is needed (R12).
      expect(await store.hasLiveRole(ids["node-ai"] as string, SCOPE)).toBe(false);
      await expect(grantInternalOnAccount(store, { me: person(ids.alice as string), principalUserId: ids.agent as string, scope: SCOPE, declaredScopes })).rejects.toMatchObject({ code: "not_pending" });
      // The SQL itself refuses an outside principal, whatever the caller does.
      expect(await store.insertAccountRole({ principalUserId: ids.agent as string, scope: SCOPE, approvedBy: ids.bob as string, days: 7 })).toBe(false);
      expect(await store.hasLiveAccountGrant(ids.agent as string, SCOPE, accounts.bob as string)).toBe(false);
    });

    it("an outside agent with no ask cannot be turned On; it has to ask", async () => {
      const { store, ids } = await h.setup(spec);
      await expect(grantRole(store, { principalUserId: ids.agent as string, scope: NODE_SCOPE, me: person(ids.alice as string, {}), declaredScopes })).rejects.toMatchObject({ code: "not_pending" });
    });

    it("v0 limit: one open row per AI and scope, so a second account cannot be added while the first is live", async () => {
      const { store, ids, accounts } = await h.setup(spec);
      expect((await grantInternalOnAccount(store, { me: person(ids.alice as string), principalUserId: ids["node-ai"] as string, scope: SCOPE, declaredScopes })).created).toBe(true);
      expect((await grantInternalOnAccount(store, { me: person(ids.bob as string), principalUserId: ids["node-ai"] as string, scope: SCOPE, declaredScopes })).created).toBe(false);
      expect(await store.hasLiveAccountGrant(ids["node-ai"] as string, SCOPE, accounts.bob as string)).toBe(false);
    });

    it("an account row is invisible to the node plane, and a node row to the account plane", async () => {
      const { store, ids, accounts } = await h.setup(spec);
      await grantInternalOnAccount(store, { me: person(ids.alice as string), principalUserId: ids["node-ai"] as string, scope: SCOPE, declaredScopes });
      await ask(store, ids.agent as string, NODE_SCOPE);
      await grantRole(store, { principalUserId: ids.agent as string, scope: NODE_SCOPE, me: person(ids.bob as string, {}), declaredScopes });
      expect((await store.listRoleRows(50)).rows.every((r) => r.resource === "node")).toBe(true);
      expect((await store.listAccountRoleRows(accounts.alice as string, 50)).every((r) => r.resource === "account")).toBe(true);
      expect(await store.liveScopes(ids["node-ai"] as string, [SCOPE])).toEqual([]);
      expect(await store.liveAccountScopes(ids.agent as string, [NODE_SCOPE], accounts.alice as string)).toEqual([]);
      expect(await store.listAccountRoleRows(accounts.bob as string, 50)).toEqual([]); // another owner's account lists nothing of alice's
    });
  });
}
