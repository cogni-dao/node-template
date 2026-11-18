// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-authority.int.test`
 * Purpose: Runtime agent tool authority against real Postgres with migrations 0036 and 0037 applied to a fresh
 *   database (task.5456): V2 seeds, role rows through the real adapter, the RLS wall, account scope removed,
 *   the wallet-binding trigger, the wallet-bound admin check, and the guard end to end over a real transaction.
 * Scope: `@cogni-dao/agent-grants` + `bootstrap/agent-authority` + database policies. No HTTP, no LLM.
 * Invariants:
 *   - SERVICE_ROLE_ONLY: the app role sees no `agent_roles` / `agent_principals` row.
 *   - AGENT_WALLET_IS_NOT_A_PAYEE: an agent may bind a wallet and be seen by the admin check, but no payout leaf resolves to its wallet.
 *   - NEVER_CACHED: a revoke denies the very next guarded call.
 * Side-effects: IO (testcontainers Postgres)
 * Notes: DATABASE_SERVICE_URL = BYPASSRLS; DATABASE_URL = app role with FORCE RLS.
 * Links: app/src/adapters/server/db/migrations/0036_agent_authority.sql, 0037_seed_agent_principals.sql
 */

import { randomUUID } from "node:crypto";
import { guardTools, ToolAuthorityError, type SqlTag } from "@cogni/agent-grants";
import { createPostgresCredentialStore, type CredentialSql, hashAgentKey } from "@cogni/agent-grants/credentials";
import {
  NODE_AI_PRINCIPAL_SLUG,
  NODE_AI_PRINCIPAL_USER_ID,
  PRIORITIZER_PRINCIPAL_SLUG,
  PRIORITIZER_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AgentAuthoritySql,
  createAdminCheck,
  createAgentToolAuthority,
} from "@/bootstrap/agent-authority";
import { makeLogger } from "@/shared/observability";

const ADMIN_WALLET = `0x${"ad".repeat(20)}`;

describe("agent authority (real Postgres)", () => {
  let service: Sql;
  let app: Sql;
  let serviceUrl: string;
  const created = {
    users: [] as string[],
    roles: [] as string[],
  };

  const makeUser = async (wallet?: string) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`t-${id.slice(0, 6)}`})`;
    if (wallet)
      await service`INSERT INTO user_bindings (id, user_id, provider, external_id)
        VALUES (${randomUUID()}, ${id}, 'wallet', ${wallet})`;
    created.users.push(id);
    return id;
  };

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL)
      throw new Error("component PostgreSQL required");
    serviceUrl = process.env.DATABASE_SERVICE_URL;
    service = postgres(serviceUrl, { max: 4 });
    app = postgres(process.env.DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_roles WHERE approved_by = ANY($1) OR principal_user_id = ANY($1) OR requested_by = ANY($1)", [
      created.users,
    ]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [created.users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [created.users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [created.users]);
    await service?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
  });

  describe("V2: migration applies to a fresh database and seeds both principals", () => {
    it("has the node-ai and prioritizer internal principals", async () => {
      const rows = await service`
        SELECT slug, kind, user_id FROM agent_principals WHERE kind = 'internal' ORDER BY slug`;
      expect(rows.map((r) => ({ slug: r.slug, kind: r.kind, user_id: r.user_id }))).toEqual([
        { slug: NODE_AI_PRINCIPAL_SLUG, kind: "internal", user_id: NODE_AI_PRINCIPAL_USER_ID },
        { slug: PRIORITIZER_PRINCIPAL_SLUG, kind: "internal", user_id: PRIORITIZER_PRINCIPAL_USER_ID },
      ]);
    });

    it("seeded users hold no wallet, no binding and no credential", async () => {
      const users = await service`
        SELECT id, wallet_address FROM users WHERE id IN (${NODE_AI_PRINCIPAL_USER_ID}, ${PRIORITIZER_PRINCIPAL_USER_ID})`;
      expect(users).toHaveLength(2);
      expect(users.every((u) => u.wallet_address === null)).toBe(true);
      const bindings = await service`
        SELECT 1 FROM user_bindings WHERE user_id IN (${NODE_AI_PRINCIPAL_USER_ID}, ${PRIORITIZER_PRINCIPAL_USER_ID})`;
      expect(bindings).toHaveLength(0);
      // CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: agent_credentials exists (0039), and an internal principal holds no key.
      const keys = await service`
        SELECT 1 FROM agent_credentials WHERE user_id IN (${NODE_AI_PRINCIPAL_USER_ID}, ${PRIORITIZER_PRINCIPAL_USER_ID})`;
      expect(keys).toHaveLength(0);
    });

    it("seeds no role rows", async () => {
      const roles = await service`
        SELECT 1 FROM agent_roles WHERE principal_user_id IN (${NODE_AI_PRINCIPAL_USER_ID}, ${PRIORITIZER_PRINCIPAL_USER_ID})`;
      expect(roles).toHaveLength(0);
    });

    it("rejects an internal principal with no slug and a duplicate slug", async () => {
      const u1 = await makeUser();
      const u2 = await makeUser();
      await expect(
        service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('internal', NULL, ${u1})`
      ).rejects.toThrow(/agent_principals_internal_has_slug/);
      await expect(
        service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('internal', ${NODE_AI_PRINCIPAL_SLUG}, ${u2})`
      ).rejects.toThrow(/agent_principals_slug_unique/);
    });
  });

  describe("RLS: only the service role touches role rows or writes principals", () => {
    it("the app role sees no role row, reads principals, and can write neither", async () => {
      const u = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by)
        VALUES (${NODE_AI_PRINCIPAL_USER_ID}, 'rls:probe', ${u})`;
      expect(await app`SELECT 1 FROM agent_roles`).toHaveLength(0);
      // Other component files register external principals concurrently; the seeded internal pair is what this proves readable.
      expect(await app`SELECT slug FROM agent_principals WHERE kind = 'internal'`).toHaveLength(2);
      await expect(
        app`INSERT INTO agent_roles (principal_user_id, scope, approved_by)
          VALUES (${NODE_AI_PRINCIPAL_USER_ID}, 'rls:write', ${u})`
      ).rejects.toThrow();
      await expect(
        app`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('internal', 'app-written', ${u})`
      ).rejects.toThrow();
    });
  });

  describe("AGENT_WALLET_IS_NOT_A_PAYEE: an agent may bind a wallet, but is never a payee (database trigger)", () => {
    const addr = () => `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`;
    const makeAgent = async (wallet: string) => {
      const agent = await makeUser(wallet);
      await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('external', NULL, ${agent})`;
      return agent;
    };

    it("lets an agent principal bind a wallet, and the admin check then sees it", async () => {
      const wallet = addr();
      const agent = await makeAgent(wallet);
      const check = createAdminCheck(service as unknown as AgentAuthoritySql, {
        check: async (input) => (input.walletAddress === wallet ? { ok: true } : { ok: false, errorCode: "authz_denied" }),
      });
      expect(await check(agent)).toBe("allow");
    });

    it("holds one owner per wallet whatever the casing (database unique index)", async () => {
      const wallet = addr();
      await makeAgent(wallet);
      const other = await makeUser();
      await expect(
        service`INSERT INTO user_bindings (id, user_id, provider, external_id)
          VALUES (${randomUUID()}, ${other}, 'wallet', ${`0x${wallet.slice(2).toUpperCase()}`})`
      ).rejects.toThrow(/user_bindings_wallet_lower_unique/);
    });

    // The guard runs as the invoker. The leaf tables are written by the BYPASSRLS service role (`service` here, a real non-superuser role,
    // exactly as in production), which sees users and user_bindings in full. These inserts hit the REAL tables: a guard that never fires fails here.
    describe("the real payout tables refuse an agent wallet", () => {
      const nodeId = randomUUID();
      const scopeId = randomUUID();
      let leafIndex = 0;
      let epochId = "";
      let manifestId = "";
      let revisionId = "";

      beforeAll(async () => {
        const [epoch] = await service`INSERT INTO epochs (node_id, scope_id, period_start, period_end, weight_config)
          VALUES (${nodeId}, ${scopeId}, now() - interval '2 days', now() - interval '1 day', '{}'::jsonb) RETURNING id`;
        epochId = String(epoch?.id);
        const [manifest] = await service`INSERT INTO epoch_distribution_manifests
          (node_id, scope_id, epoch_id, distribution_id, statement_hash, merkle_root, chain_id, token_address, distribution_amount, total_allocated)
          VALUES (${nodeId}, ${scopeId}, ${epochId}, 'd', 'h', 'r', 1, '0x00', 0, 0) RETURNING id`;
        manifestId = String(manifest?.id);
        const [revision] = await service`INSERT INTO distribution_settlement_revisions
          (node_id, scope_id, sequence, distribution_id, statement_hash, merkle_root, chain_id, token_address, mint_delta, cumulative_total, trigger_kind, trigger_ref)
          VALUES (${nodeId}, ${scopeId}, 1, 'd', 'h', 'r', 1, '0x00', 0, 0, 'probe', 'probe') RETURNING id`;
        revisionId = String(revision?.id);
      });

      const epochLeaf = (wallet: string) =>
        service`INSERT INTO epoch_distribution_leaves
          (node_id, manifest_id, epoch_id, leaf_index, claimant_key, account, account_lower, amount, leaf_hash, proof_json)
          VALUES (${nodeId}, ${manifestId}, ${epochId}, ${leafIndex++}, 'user:x', ${wallet}, ${wallet.toLowerCase()}, 1, 'h', '[]'::jsonb)`;
      const settlementLeaf = (wallet: string) =>
        service`INSERT INTO distribution_settlement_leaves
          (revision_id, leaf_index, claimant_key, account, account_lower, cumulative_amount, delta_amount, receipt_ids_json, leaf_hash, proof_json)
          VALUES (${revisionId}, ${leafIndex++}, 'user:x', ${wallet}, ${wallet.toLowerCase()}, 1, 1, '[]'::jsonb, 'h', '[]'::jsonb)`;

      it("accepts a human's wallet on both tables (the positive control: the fixtures are valid)", async () => {
        const human = addr();
        await makeUser(human);
        await epochLeaf(human);
        await settlementLeaf(human);
      });

      it("refuses an agent's wallet on both tables, in any casing", async () => {
        const wallet = addr();
        await makeAgent(wallet);
        await expect(epochLeaf(wallet)).rejects.toThrow(/cannot be a payee/);
        await expect(settlementLeaf(wallet)).rejects.toThrow(/cannot be a payee/);
        await expect(epochLeaf(`0x${wallet.slice(2).toUpperCase()}`)).rejects.toThrow(/cannot be a payee/);
      });
    });
  });

  describe("role rows through the real authority", () => {
    const authority = () =>
      createAgentToolAuthority({
        sql: service as unknown as AgentAuthoritySql,
        nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
        log: makeLogger({ component: "agent-authority-test" }),
        toolBundle: [],
      });

    it("grants once, is idempotent, and revokes softly", async () => {
      const admin = await makeUser();
      const a = createAgentToolAuthority({
        sql: service as unknown as AgentAuthoritySql,
        nodeAdmin: { check: async () => ({ ok: true }) },
        log: makeLogger({ component: "agent-authority-test" }),
        toolBundle: (await import("@cogni/ai-tools")).CORE_TOOL_BUNDLE as never,
      });
      const first = await a.grantRole({ principalSlug: "node-ai", scope: "knowledge:write", me: { userId: admin, admin: {} } });
      expect(first).toEqual({ principalUserId: NODE_AI_PRINCIPAL_USER_ID, created: true });
      expect((await a.grantRole({ principalSlug: "node-ai", scope: "knowledge:write", me: { userId: admin, admin: {} } })).created).toBe(false);
      const live = await service`SELECT 1 FROM agent_roles WHERE principal_user_id = ${NODE_AI_PRINCIPAL_USER_ID} AND scope = 'knowledge:write' AND revoked_at IS NULL`;
      expect(live).toHaveLength(1);
      expect((await a.revokeRole({ principalSlug: "node-ai", scope: "knowledge:write", me: { userId: admin, admin: {} } })).revoked).toBe(true);
      const rows = await service`SELECT revoked_at FROM agent_roles WHERE principal_user_id = ${NODE_AI_PRINCIPAL_USER_ID} AND scope = 'knowledge:write'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
      // After a revoke the same role can be granted again as a new live row.
      expect((await a.grantRole({ principalSlug: "node-ai", scope: "knowledge:write", me: { userId: admin, admin: {} } })).created).toBe(true);
      await a.revokeRole({ principalSlug: "node-ai", scope: "knowledge:write", me: { userId: admin, admin: {} } });
    });

    it("rejects an undeclared scope and an unknown principal", async () => {
      const admin = await makeUser();
      await expect(
        authority().grantRole({ principalSlug: "node-ai", scope: "made:up", me: { userId: admin, admin: {} } })
      ).rejects.toMatchObject({ code: "invalid_scope" });
      const a = createAgentToolAuthority({
        sql: service as unknown as AgentAuthoritySql,
        nodeAdmin: { check: async () => ({ ok: true }) },
        log: makeLogger({ component: "agent-authority-test" }),
        toolBundle: (await import("@cogni/ai-tools")).CORE_TOOL_BUNDLE as never,
      });
      await expect(
        a.grantRole({ principalSlug: "ghost", scope: "knowledge:write", me: { userId: admin, admin: {} } })
      ).rejects.toMatchObject({ code: "principal_not_found" });
    });

    it("resolves a seeded slug and returns null for a missing seed row", async () => {
      const a = authority();
      expect(await a.resolvePrincipal("prioritizer")).toBe(PRIORITIZER_PRINCIPAL_USER_ID);
      expect(await a.resolvePrincipal("not-seeded")).toBeNull();
    });
  });

  describe("the account plane is one more resource on the same row", () => {
    it("ships the one grant row with the RLS function, no account-grant table, and the app role can read only its own account rows", async () => {
      expect(await service`SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_capability_grants'`).toHaveLength(0);
      expect(await service`SELECT 1 FROM pg_proc WHERE proname = 'agent_has_scope'`).toHaveLength(1);
      expect(await service`SELECT 1 FROM pg_policies WHERE tablename = 'agent_roles' AND policyname = 'agent_roles_account_self_read'`).toHaveLength(1);
      // Only one policy on agent_roles, and it is select-only: the app role never writes a grant.
      expect(await service`SELECT cmd FROM pg_policies WHERE tablename = 'agent_roles'`).toEqual([expect.objectContaining({ cmd: "SELECT" })]);
    });

    it("denies an account tool with no account (no_account) and a node row never opens it", async () => {
      const { createPostgresAgentGrantsStore, authorize } = await import("@cogni/agent-grants");
      const admin = await makeUser();
      // A throwaway principal (not a seeded AI), so no other file that counts the seeded AI's rows sees this one.
      const holder = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${holder}, 'account:read', ${admin})`;
      const decide = (accountId?: string) =>
        service.begin((tx) =>
          authorize(createPostgresAgentGrantsStore(tx), async () => "allow", {
            principalId: holder,
            subjectUserId: admin,
            accountId,
            requires: { scope: "account:read", kind: "account", subject: "member" },
          })
        );
      expect(await decide()).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_account" });
      expect(await decide("acct-x")).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_role" });
    });
  });

  describe("wallet-bound admin check (N7)", () => {
    it("two admin-subject bearers finish on max2 without reacquiring the root pool", async () => {
      const POOL_ADMIN_WALLET = `0x${"fe".repeat(20)}`;
      const pool = postgres(serviceUrl, { max: 2 });
      const allowed = await makeUser(), denied = await makeUser(), approver = await makeUser();
      // An admin is a wallet the DAO lists, for any principal (ONE_ADMIN_CHECK): the allowed agent holds one, bound before its principal row exists.
      await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${allowed}, 'wallet', ${POOL_ADMIN_WALLET})`;
      for (const user of [allowed, denied]) {
        await service`INSERT INTO agent_principals(kind,user_id) VALUES('external',${user})`;
        await service`INSERT INTO agent_roles(principal_user_id,scope,approved_by) VALUES(${user},'service_link:manage',${approver})`;
      }
      let roleReads = 0, release!: () => void;
      const bothRoles = new Promise<void>((resolve) => { release = resolve; });
      const root: SqlTag = (strings, ...values) => (pool as unknown as SqlTag)(strings, ...values);
      const sql: AgentAuthoritySql = Object.assign(root, {
        async begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T> {
          const result = await pool.begin(async (native) => {
            const tx: SqlTag = async (strings, ...values) => {
              const rows = await (native as unknown as SqlTag)(strings, ...values);
              if (strings.join("?").includes("FROM agent_roles") && ++roleReads <= 2) {
                if (roleReads === 2) release();
                await bothRoles;
              }
              return rows;
            };
            return { value: await fn(tx) };
          });
          return result.value;
        },
      });
      // Both role reads own a real connection before either admin read proceeds.
      const authority = createAgentToolAuthority({ sql, toolBundle: [], log: makeLogger({ component: "max2-authority-test" }),
        nodeAdmin: { check: async ({ walletAddress }) => walletAddress === POOL_ADMIN_WALLET ? { ok: true } : { ok: false, errorCode: "authz_denied" } },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = <T,>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("max2 authority stalled")), 2000);
      })]).finally(() => clearTimeout(timer));
      try {
        const decide = (userId: string) => authority.authorizeRoute({ userId, via: "bearer", toolId: "service-link.manage", routeId: "service.links.create" });
        expect(await bounded(Promise.all([decide(allowed), decide(denied)]))).toEqual([
          { decision: "allow", basis: "role" }, { decision: "deny", code: "policy_denied", reason: "subject_not_admin" },
        ]);
        expect(roleReads).toBe(2);
        const store = createPostgresCredentialStore(pool as unknown as CredentialSql, { hasRoles: async () => false });
        expect(await bounded(store.lookup(await hashAgentKey(randomUUID())))).toBeNull();
        await service`UPDATE agent_roles SET revoked_at=clock_timestamp() WHERE principal_user_id=${allowed} AND scope='service_link:manage'`;
        expect(await bounded(decide(allowed))).toMatchObject({ decision: "deny", reason: "no_role" });
      } finally { release(); await pool.end({ timeout: 0 }); }
    });

    const nodeAdmin = (admins: string[]) => ({
      check: async (actor: { walletAddress?: string | null }) =>
        admins.length === 0
          ? ({ ok: false, errorCode: "authz_unavailable", reason: "no_node_admins_configured" } as const)
          : actor.walletAddress && admins.includes(actor.walletAddress)
            ? ({ ok: true } as const)
            : ({ ok: false, errorCode: "authz_denied" } as const),
    });

    it("allows any bound admin wallet, denies a non-admin and a user with no wallet", async () => {
      const check = createAdminCheck(service as unknown as AgentAuthoritySql, nodeAdmin([ADMIN_WALLET]));
      const adminUser = await makeUser(`0x${"11".repeat(20)}`);
      await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${adminUser}, 'wallet', ${ADMIN_WALLET})`;
      expect(await check(adminUser)).toBe("allow");
      expect(await check(await makeUser(`0x${"22".repeat(20)}`))).toBe("denied");
      expect(await check(await makeUser())).toBe("denied");
      expect(await check(NODE_AI_PRINCIPAL_USER_ID)).toBe("denied");
    });

    it("reports no configured admins as unavailable", async () => {
      const check = createAdminCheck(service as unknown as AgentAuthoritySql, nodeAdmin([]));
      expect(await check(await makeUser(`0x${"33".repeat(20)}`))).toBe("unavailable");
      expect(await check(await makeUser())).toBe("unavailable");
    });
  });

  describe("guard end to end over a real transaction", () => {
    it("denies, allows after grant, denies after revoke; no principal always denies", async () => {
      const admin = await makeUser();
      const bundle = (await import("@cogni/ai-tools")).CORE_TOOL_BUNDLE;
      const authority = createAgentToolAuthority({
        sql: service as unknown as AgentAuthoritySql,
        nodeAdmin: { check: async () => ({ ok: true }) },
        log: makeLogger({ component: "agent-authority-test" }),
        toolBundle: bundle as never,
      });
      const runtime = {
        id: "core__work_item_update",
        effect: "state_change",
        exec: async () => "ran",
      };
      const requiresById = { core__work_item_update: { scope: "work_item:transition", kind: "node" as const, subject: "member" as const } };
      const guarded = (principalId?: string) =>
        guardTools({ [runtime.id]: runtime } as never, requiresById, { principalId, subjectUserId: undefined, payer: "payer-1" }, authority.guardDeps)[runtime.id]!;
      const call = (principalId?: string) =>
        (guarded(principalId).exec as (a: unknown, c: unknown, k: unknown) => Promise<unknown>)({}, { runId: "r" }, {});

      await expect(call(PRIORITIZER_PRINCIPAL_USER_ID)).rejects.toBeInstanceOf(ToolAuthorityError);
      await authority.grantRole({ principalSlug: "prioritizer", scope: "work_item:transition", me: { userId: admin, admin: {} } });
      await expect(call(PRIORITIZER_PRINCIPAL_USER_ID)).resolves.toBe("ran");
      await expect(call(undefined)).rejects.toMatchObject({ receipt: { code: "policy_denied" } });
      await authority.revokeRole({ principalSlug: "prioritizer", scope: "work_item:transition", me: { userId: admin, admin: {} } });
      await expect(call(PRIORITIZER_PRINCIPAL_USER_ID)).rejects.toMatchObject({ receipt: { code: "policy_denied", retryable: false } });
    });
  });

  describe("the route door and the run-start filter over real Postgres", () => {
    const bundle = async () => (await import("@cogni/ai-tools")).CORE_TOOL_BUNDLE;
    const make = async () =>
      createAgentToolAuthority({
        sql: service as unknown as AgentAuthoritySql,
        nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
        log: makeLogger({ component: "agent-authority-test" }),
        toolBundle: (await bundle()) as never,
      });

    it("authorizeRoute: a bearer needs a live role row; revoke closes the door; a human session needs none", async () => {
      const admin = await makeUser();
      const agent = await makeUser(); // an outside agent: an ordinary users row, not an agent_principals row
      const a = await make();
      const route = (via: "bearer" | "session", toolId = "core__work_item_update") =>
        a.authorizeRoute({ toolId, routeId: "work.items.patch", userId: agent, via });
      expect(await route("bearer")).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_role" });
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${agent}, 'work_item:transition', ${admin})`;
      expect(await route("bearer")).toMatchObject({ decision: "allow", basis: "role" });
      expect(await route("bearer", "core__edo_decide")).toMatchObject({ decision: "deny", reason: "no_role" }); // a role for one scope opens no other
      await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${agent} AND scope = 'work_item:transition'`;
      expect(await route("bearer")).toMatchObject({ decision: "deny", reason: "no_role" });
      expect(await route("session")).toMatchObject({ decision: "allow", basis: "signed_in" }); // a human needs no row
      expect(await route("bearer", "no.such.tool")).toMatchObject({ decision: "deny", reason: "no_requires" });
    });

    it("authorizeRoute: the route-only knowledge.contribute scope works the same way", async () => {
      const admin = await makeUser();
      const agent = await makeUser();
      const a = await make();
      const route = (via: "bearer" | "session") =>
        a.authorizeRoute({ toolId: "knowledge.contribute", routeId: "knowledge.contributions.create", userId: agent, via });
      expect(await route("bearer")).toMatchObject({ decision: "deny", reason: "no_role" });
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${agent}, 'knowledge:contribute', ${admin})`;
      expect(await route("bearer")).toMatchObject({ decision: "allow" });
      expect(await route("session")).toMatchObject({ decision: "allow" });
    });

    it("liveScopes returns only this principal's live scopes in one read", async () => {
      const admin = await makeUser();
      const agent = await makeUser();
      const other = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, revoked_at) VALUES (${agent}, 'a:live', ${admin}, NULL), (${agent}, 'b:revoked', ${admin}, now()), (${other}, 'c:other', ${admin}, NULL)`;
      const { createPostgresAgentGrantsStore } = await import("@cogni/agent-grants");
      const store = createPostgresAgentGrantsStore(service as never);
      expect(await store.liveScopes(agent, ["a:live", "b:revoked", "c:other", "d:none"])).toEqual(["a:live"]);
      expect(await store.liveScopes(agent, [])).toEqual([]);
    });
  });

  describe("pending, denied, backfilled and revoked rows over real Postgres (0038)", () => {
    const store = async () => (await import("@cogni/agent-grants")).createPostgresAgentGrantsStore(service as never);
    const SCOPES = ["edo:write", "work_item:transition"];
    const insert = (principal: string, scope: string, fields: { approvedBy?: string | null; revoked?: boolean; grantedAt?: boolean }) =>
      service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, requested_by, granted_at, revoked_at)
        VALUES (${principal}, ${scope}, ${fields.approvedBy ?? null}, ${principal}, ${fields.grantedAt ? new Date() : null}, ${fields.revoked ? new Date() : null})`;

    it("a pending ask opens no lock: hasLiveRole and liveScopes both say no", async () => {
      const agent = await makeUser();
      await insert(agent, "edo:write", {});
      const st = await store();
      expect(await st.hasLiveRole(agent, "edo:write")).toBe(false);
      expect(await st.liveScopes(agent, SCOPES)).toEqual([]);
      expect(await st.listOwnRoles(agent)).toEqual([expect.objectContaining({ scope: "edo:write", state: "pending" })]);
    });

    it("a denied ask (never approved, revoked) opens no lock and is not pending", async () => {
      const agent = await makeUser();
      await insert(agent, "edo:write", { revoked: true });
      const st = await store();
      expect(await st.hasLiveRole(agent, "edo:write")).toBe(false);
      expect(await st.liveScopes(agent, SCOPES)).toEqual([]);
      expect(await st.listOwnRoles(agent)).toEqual([expect.objectContaining({ scope: "edo:write", state: "denied" })]);
      expect((await st.listRoleRows(100)).rows.filter((r) => r.principalUserId === agent)).toEqual([]); // not an ask on the admin table
    });

    it("a row written before 0038 (approved, no granted_at) still authorizes, and the migration backfill sets granted_at", async () => {
      const admin = await makeUser();
      const agent = await makeUser();
      await insert(agent, "edo:write", { approvedBy: admin, grantedAt: false });
      const st = await store();
      expect(await st.hasLiveRole(agent, "edo:write")).toBe(true);
      expect(await st.liveScopes(agent, SCOPES)).toEqual(["edo:write"]);
      // Run the migration's own backfill statement against this old-shape row.
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const sqlText = readFileSync(resolve(__dirname, "../../../src/adapters/server/db/migrations/0038_agent_access_requests.sql"), "utf8");
      const backfill = /UPDATE "agent_roles" SET "granted_at"[^;]*;/.exec(sqlText)?.[0];
      expect(backfill).toBeTruthy();
      await service.unsafe(backfill as string);
      const row = (await service`SELECT granted_at, created_at FROM agent_roles WHERE principal_user_id = ${agent}`)[0];
      expect(row?.granted_at).not.toBeNull();
      expect(new Date(row?.granted_at as Date).getTime()).toBe(new Date(row?.created_at as Date).getTime());
      // NAMES_ARE_IDENTIFIERS: there is no display-name column; the slug is the name.
      const columns = await service`SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_principals' AND column_name = 'display_name'`;
      expect(columns).toHaveLength(0);
    });

    it("approved then revoked: live while approved, off after", async () => {
      const admin = await makeUser();
      const agent = await makeUser();
      const st = await store();
      expect(await st.requestRole({ principalUserId: agent, scope: "edo:write", resource: "node", link: { hash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) }, maxPending: 3, maxPendingTotal: 1000 })).toBe("created");
      expect(await st.hasLiveRole(agent, "edo:write")).toBe(false);
      expect(await st.approvePending({ principalUserId: agent, scope: "edo:write", approvedBy: admin })).toBe(true);
      expect(await st.hasLiveRole(agent, "edo:write")).toBe(true);
      expect(await st.liveScopes(agent, SCOPES)).toEqual(["edo:write"]);
      expect(await st.revokeRole({ principalUserId: agent, scope: "edo:write" })).toBe(true);
      expect(await st.hasLiveRole(agent, "edo:write")).toBe(false);
      expect(await st.liveScopes(agent, SCOPES)).toEqual([]);
      expect(await st.listOwnRoles(agent)).toEqual([expect.objectContaining({ state: "revoked" })]);
    });

    it("NO_SELF_APPROVAL in SQL: an approver id equal to the principal approves nothing", async () => {
      const agent = await makeUser();
      await insert(agent, "edo:write", {});
      const st = await store();
      expect(await st.approvePending({ principalUserId: agent, scope: "edo:write", approvedBy: agent })).toBe(false);
      expect(await st.hasLiveRole(agent, "edo:write")).toBe(false);
    });

    it("nameTaken: this node's AI names, any user's name, in any case, spacing or look-alike form; a fresh name is free", async () => {
      const a = createAgentToolAuthority({
        sql: service as unknown as AgentAuthoritySql,
        nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
        log: makeLogger({ component: "agent-authority-test" }),
        toolBundle: [],
      });
      // This node's AI are identified by slug: that is what an outside agent must not copy.
      expect(await a.nameTaken("node-ai")).toBe(true);
      expect(await a.nameTaken("  NODE-AI ")).toBe(true);
      expect(await a.nameTaken("prioritizer")).toBe(true);
      expect(await a.nameTaken("\uFF50rioritizer")).toBe(true); // fullwidth p
      expect(await a.nameTaken("General assistant")).toBe(false); // a vanity label is not an identifier and is free
      const id = await makeUser();
      await service`UPDATE users SET name = 'Zed  The  Agent' WHERE id = ${id}`;
      expect(await a.nameTaken("zed the agent")).toBe(true);
      expect(await a.nameTaken(`Brand new ${randomUUID().slice(0, 8)}`)).toBe(false);
      expect(await a.nameTaken("   ")).toBe(true);
    });
  });
});
