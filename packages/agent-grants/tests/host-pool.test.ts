// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/host-pool`
 * Purpose: OWNERS_READ_BEFORE_THE_TRANSACTION. The org-statement owner source needs a SECOND database connection (wallet mapping, held version, refresh). If a decision read it INSIDE its
 *   transaction, two concurrent org requests on a pool of two would each hold one connection and wait for another forever. This test runs two concurrent org-account decisions over a fake
 *   pool of TWO connections and requires both to finish.
 * Scope: Pure over a counting fake pool and a stub org origin. No database, no network.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { newLinkToken } from "../src/approval";
import { type AgentAuthoritySql, createAgentToolAuthority } from "../src/host";
import { createOrgStatementIssuer, ORG_JWKS_PATH, ORG_STATEMENT_PATH, type OrgFetch } from "../src/org-statement";
import { createServiceAssertionSignerFromSeed } from "../src/service-auth";

const ORIGIN = "https://toks5.example.com";
const ADMIN_WALLET = "0x00000000000000000000000000000000000000a1";

/** A pool of `max` connections: a bare query takes one for its own duration, a transaction holds one for its whole body. A query that finds none waits, like postgres.js. */
function fakePool(max: number, answer: (text: string) => Array<Record<string, unknown>>) {
  let free = max;
  const waiting: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      const take = () => {
        free -= 1;
        resolve();
      };
      if (free > 0) take();
      else waiting.push(take);
    });
  const release = () => {
    free += 1;
    waiting.shift()?.();
  };
  const tag = async (strings: TemplateStringsArray) => {
    await acquire();
    try {
      await Promise.resolve();
      return answer(strings.join("?"));
    } finally {
      release();
    }
  };
  const begin = async <T>(fn: (tx: (strings: TemplateStringsArray) => Promise<Array<Record<string, unknown>>>) => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn(async (strings) => answer(strings.join("?")));
    } finally {
      release();
    }
  };
  return Object.assign(tag, { begin }) as unknown as AgentAuthoritySql;
}

describe("org decisions on a small connection pool", () => {
  it("two concurrent decisions on an org account both finish on a pool of two (owners are read before the transaction opens)", async () => {
    const signer = await createServiceAssertionSignerFromSeed({ issuer: ORIGIN, seedHex: "11".repeat(32) });
    const issuer = createOrgStatementIssuer({ signer, origin: ORIGIN, nodeId: "toks5", version: 1_790_000_000, facts: () => ({ dao: null, admins: [ADMIN_WALLET], services: [], commit: null }) });
    const orgFetch: OrgFetch = async (_origin, path) => (path === ORG_STATEMENT_PATH ? issuer.statement() : path === ORG_JWKS_PATH ? JSON.stringify(signer.jwks()) : Promise.reject(new Error("path")));
    const token = newLinkToken();
    const sql = fakePool(2, (text) => {
      if (text.includes("FROM billing_accounts b") && text.includes("JOIN agent_principals p")) return [{ owner_source_kind: "org-statement", owner_source_ref: ORIGIN }];
      if (text.includes("FROM user_bindings") && text.includes("ANY")) return [{ user_id: "admin" }];
      if (text.includes("FROM agent_roles r") && text.includes("JOIN users u")) return [{ principal_user_id: "agent", scope: "account:read", resource: "account", created_at: new Date(), kind: "external", user_name: "bot" }];
      return [];
    });
    const authority = createAgentToolAuthority({
      sql,
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tools: [],
      graphs: [],
      systemUserIds: [],
      nodeId: "me",
      directory: [{ origin: ORIGIN, nodeId: "toks5" }],
      orgFetch,
    });
    const decide = () => authority.turnMineOff({ userId: "admin", admin: null }, { token, accountId: "acct-org" });
    const outcome = await Promise.race([Promise.all([decide(), decide()]).then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("deadlocked"), 2000))]);
    expect(outcome).toBe("finished");
  });
});
