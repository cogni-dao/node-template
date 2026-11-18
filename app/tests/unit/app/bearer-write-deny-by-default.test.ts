// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/bearer-write-deny-by-default`
 * Purpose: DENY_BY_DEFAULT (bug.0045). Scans EVERY `app/src/app/api/** /route.ts` and every exported write method (POST, PUT, PATCH, DELETE; `export const`,
 *   `export async function` and `export { x as POST }`). A bearer-capable write route must declare a door (`sameDoor`), an own-data reason (`bearerWrite`),
 *   or be open by design; a deliberate refusal must be named here with its reason. An `auth.mode: "none"` write route must sit under `internal/`, be
 *   `agent.register`, or be named here as a route that checks a credential or session itself. A new write route cannot ship without one of these choices.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DEFERRED_WRITE_ROUTES, OPEN_BY_DESIGN_ROUTES, ROUTE_ONLY_CAPABILITIES, SAME_DOOR_ROUTES } from "@cogni/agent-grants";
import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "../../../src/app/api");
const WRITE_METHODS = "POST|PUT|PATCH|DELETE";

/** A bearer-capable write route that is refused on purpose: a bearer gets 403 `bearer_write_undeclared`. Each reason says why no door or own-data reason fits. */
const REFUSED_FOR_BEARERS: Readonly<Record<string, string>> = {
  "ledger.finalize-epoch": "epoch approver wallet required (checkApprover); a bearer has no wallet",
  "ledger.record-pool-component": "epoch approver wallet required (checkApprover); a bearer has no wallet",
  "ledger.patch-review-subject-overrides": "epoch approver wallet required (checkApprover); a bearer has no wallet",
  "ledger.delete-review-subject-override": "epoch approver wallet required (checkApprover); a bearer has no wallet",
  "ledger.review-epoch": "epoch approver wallet required (checkApprover); a bearer has no wallet",
  "ledger.collect-trigger": "starts the ledger ingest schedule; an operator act with no AI door, so a bearer is refused",
  "ledger.update-user-projections": "retired (HTTP 410); nothing to gate",
  "payments.intents": "needs a bound wallet (WalletRequiredError); a bearer may now bind one (/api/v1/identity/wallet/bind), but credits purchase has no AI door, so a bearer is refused",
  "payments.attempt_submit": "submits a transaction hash for an attempt created by a wallet-bound intent; a bearer owns no attempt",
  "payments.steward-withdrawal": "steward wallet approver only; a bearer has no wallet",
};

/** `auth.mode: "none"` write routes outside `internal/` that authenticate the caller themselves. Each reason says how. */
const MODE_NONE_SELF_AUTHENTICATED: Readonly<Record<string, string>> = {
  "admin.ai-access.preview": "requireAdminSession(): the one admin check, for a session or a bearer",
  "admin.ai-access.on": "requireAdminSession(): the one admin check, for a session or a bearer",
  "admin.ai-access.off": "requireAdminSession(): the one admin check, for a session or a bearer",
  "agent.mine.preview": "human plane: refuseNonSession() then the signed-in person",
  "agent.mine.on": "human plane: refuseNonSession() then the signed-in person",
  "agent.mine.off": "human plane: refuseNonSession() then the signed-in person",
  "agent.credentials.rotate": "credentialBearerRoute verifies the caller's own revocable key (active or renew_only) and acts on that credential only",
  "agent.credentials.confirm": "credentialBearerRoute verifies the caller's own revocable key and acts on that credential only",
  "agent.credentials.revoke": "credentialBearerRoute verifies the caller's own revocable key and acts on that credential only",
};

/** Write handlers that do not use the route wrapper at all, keyed by `<path under api>#<METHOD>`. They are not bearer-capable; each says how it authenticates. */
const UNWRAPPED_WRITES: Readonly<Record<string, string>> = {
  "auth/[...nextauth]/route.ts#POST": "NextAuth's own handler: the sign-in protocol",
  "auth/link/[provider]/route.ts#POST": "getServerSessionUser(): a signed-in cookie session only, never a bearer",
  "setup/verify/route.ts#POST": "public on-chain verification: reads receipts, writes nothing",
  "v1/auth/openai-codex/authorize/route.ts#POST": "getServerSessionUser(): a signed-in cookie session only",
  "v1/auth/openai-codex/disconnect/route.ts#POST": "getServerSessionUser(): a signed-in cookie session only",
  "v1/auth/openai-codex/exchange/route.ts#POST": "getServerSessionUser(): a signed-in cookie session only",
  "v1/auth/openai-compatible/connect/route.ts#POST": "getServerSessionUser(): a signed-in cookie session only",
  "v1/auth/openai-compatible/disconnect/route.ts#POST": "getServerSessionUser(): a signed-in cookie session only",
};

type Kind = "wrapped" | "credential" | "helper" | "unwrapped";
interface WriteExport {
  readonly path: string;
  readonly method: string;
  readonly kind: Kind;
  readonly routeId: string;
  readonly mode: "required" | "optional" | "none" | null;
  readonly bearerCapable: boolean;
  readonly sameDoor: boolean;
  readonly bearerWrite: boolean;
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === "route.ts" ? [p] : [];
  });
}

function writeExports(file: string): WriteExport[] {
  const src = readFileSync(file, "utf8");
  const path = relative(API, file);
  const out: WriteExport[] = [];
  const unwrapped = (method: string): WriteExport => ({
    path, method, kind: "unwrapped", routeId: `${path}#${method}`, mode: null, bearerCapable: false, sameDoor: false, bearerWrite: false,
  });
  for (const m of src.matchAll(new RegExp(`export\\s+(const|async\\s+function|function)\\s+(${WRITE_METHODS})\\b`, "g"))) {
    const method = m[2] as string;
    const rest = src.slice(m.index + m[0].length);
    const call = m[1] === "const" ? /^\s*=\s*([A-Za-z_]\w*)\s*(?:<[\s\S]*?>)?\s*\(/.exec(rest) : null;
    if (!call) {
      out.push(unwrapped(method));
      continue;
    }
    const callee = call[1];
    const afterCall = rest.slice(call[0].length);
    const end = afterCall.search(/\basync\b/);
    const options = afterCall.slice(0, end < 0 ? 800 : Math.min(end, 800));
    const kind: Kind = callee === "wrapRouteHandlerWithLogging" ? "wrapped" : callee === "credentialBearerRoute" ? "credential" : "helper";
    // A helper builds the wrapper elsewhere in the file: its id is its first string argument and its mode is the file's.
    const routeId = kind === "helper" ? /^\s*"([^"]+)"/.exec(afterCall)?.[1] ?? `${path}#${method}` : /routeId:\s*"([^"]+)"/.exec(options)?.[1] ?? /routeId:\s*([\w.]+)/.exec(options)?.[1] ?? `${path}#${method}`;
    const scanned = kind === "helper" ? src : options;
    const mode = kind === "credential" ? "none" : (/mode:\s*"(required|optional|none)"/.exec(scanned)?.[1] as WriteExport["mode"]) ?? "none";
    // Bearer-capable: the route resolves identity with the agent-first resolver (`@/app/_lib/auth/session`), not the cookie-only one.
    const bearerCapable =
      kind === "wrapped" && mode !== "none" && /from "@\/app\/_lib\/auth\/session"/.test(src) && !/getSessionUser:\s*getServerSessionUser/.test(options);
    out.push({ path, method, kind, routeId, mode, bearerCapable, sameDoor: /sameDoor:\s*"/.test(options), bearerWrite: /bearerWrite:\s*"[^"]{12,}"/.test(options) });
  }
  // `export { handler as POST }`
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g))
    for (const alias of (m[1] ?? "").matchAll(new RegExp(`\\bas\\s+(${WRITE_METHODS})\\b`, "g"))) out.push(unwrapped(alias[1] as string));
  return out;
}

const ALL = routeFiles(API).flatMap(writeExports);
const isInternal = (e: WriteExport) => e.path.startsWith("internal/");
const declaredByDoor = new Set(
  [...Object.values(SAME_DOOR_ROUTES), ...Object.values(ROUTE_ONLY_CAPABILITIES)].flatMap((e) => e.routes)
);

describe("DENY_BY_DEFAULT: the scan itself", () => {
  it("finds the write routes it is meant to guard (a broken scanner must not pass silently)", () => {
    const ids = new Set(ALL.map((e) => e.routeId));
    for (const id of ["work.items.create", "work.items.claim", "work.items.release", "work.items.heartbeat", "chat.completions", "ai.chat", "ai.threads.delete", "agent.credentials.upgrade", "knowledge.domains.create", "agent.access.requests.create", "ledger.finalize-epoch", "payments.intents", "admin.ai-access.on", "admin.ai-access.off", "agent.credentials.rotate", "schedules.update"])
      expect(ids.has(id), id).toBe(true);
    expect(ALL.some((e) => e.kind === "unwrapped")).toBe(true);
    expect(ALL.length).toBeGreaterThan(60);
  });
});

describe("DENY_BY_DEFAULT: every bearer-capable write route declares a door, an own-data reason, or a deliberate refusal", () => {
  const capable = ALL.filter((e) => e.bearerCapable);

  it("lists no undeclared bearer-capable write route", () => {
    const undeclared = capable
      .filter((e) => !(e.sameDoor || e.bearerWrite || e.routeId in OPEN_BY_DESIGN_ROUTES || e.routeId in REFUSED_FOR_BEARERS || e.routeId in DEFERRED_WRITE_ROUTES))
      .map((e) => `${e.method} ${e.routeId} (${e.path})`);
    expect(undeclared).toEqual([]);
  });

  it("a route with a door is in the door map, and the door names its own route (no route is both gated and refused)", () => {
    for (const e of capable.filter((e) => e.sameDoor)) {
      expect(declaredByDoor.has(e.routeId), `${e.routeId} declares sameDoor but no door lists it`).toBe(true);
      expect(e.routeId in REFUSED_FOR_BEARERS || e.routeId in DEFERRED_WRITE_ROUTES, e.routeId).toBe(false);
    }
  });

  it("a bearerWrite reason is a real sentence and never sits on a gated or open-by-design route", () => {
    for (const e of capable.filter((e) => e.bearerWrite)) {
      expect(declaredByDoor.has(e.routeId) || e.routeId in OPEN_BY_DESIGN_ROUTES, e.routeId).toBe(false);
    }
    expect(capable.filter((e) => e.bearerWrite).map((e) => e.routeId).sort()).toEqual([
      "agent.credentials.upgrade",
      "ai.chat",
      "ai.threads.delete",
      "chat.completions",
      "identity.wallet.bind",
      "identity.wallet.challenge",
    ]);
  });

  it("the refused list names real bearer-capable write routes only, so it cannot rot", () => {
    const ids = new Set(capable.map((e) => e.routeId));
    for (const id of Object.keys(REFUSED_FOR_BEARERS)) {
      expect(ids.has(id), id).toBe(true);
      expect(REFUSED_FOR_BEARERS[id]?.length, id).toBeGreaterThan(20);
    }
  });

  it("the deferred list is bearer-refused too: every entry is a bearer-capable write route with no door", () => {
    const byId = new Map(capable.map((e) => [e.routeId, e]));
    for (const id of Object.keys(DEFERRED_WRITE_ROUTES)) {
      const e = byId.get(id);
      expect(e, id).toBeDefined();
      expect(e?.sameDoor, id).toBe(false);
      expect(e?.bearerWrite, id).toBe(false);
    }
  });
});

describe("DENY_BY_DEFAULT: no auth.mode none write route is open by accident", () => {
  const none = ALL.filter((e) => e.kind !== "unwrapped" && e.mode === "none");

  it("every `mode: none` write route is under internal/, agent.register, or named as one that authenticates the caller itself", () => {
    const stray = none
      .filter((e) => !isInternal(e) && e.routeId !== "agent.register" && !(e.routeId in MODE_NONE_SELF_AUTHENTICATED))
      .map((e) => `${e.method} ${e.routeId} (${e.path})`);
    expect(stray).toEqual([]);
  });

  it("agent.register is on the open-by-design list; the self-authenticated list names real routes only", () => {
    expect("agent.register" in OPEN_BY_DESIGN_ROUTES).toBe(true);
    const ids = new Set(none.map((e) => e.routeId));
    for (const id of Object.keys(MODE_NONE_SELF_AUTHENTICATED)) expect(ids.has(id), id).toBe(true);
  });

  it("every wrapper-less write handler is under internal/ or named with how it authenticates, and the list names real handlers only", () => {
    const unwrapped = ALL.filter((e) => e.kind === "unwrapped");
    const stray = unwrapped.filter((e) => !isInternal(e) && !(`${e.path}#${e.method}` in UNWRAPPED_WRITES)).map((e) => `${e.method} ${e.path}`);
    expect(stray).toEqual([]);
    const real = new Set(unwrapped.map((e) => `${e.path}#${e.method}`));
    for (const key of Object.keys(UNWRAPPED_WRITES)) expect(real.has(key), key).toBe(true);
  });
});
