// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/remote-knowledge`
 * Purpose: Read another node's knowledge through the stock knowledge tools (story.0038 phase 2). The host builds ONE transport from server config; the tools only
 *   name a node alias. The transport, not the tool and not the model, holds the target list and asks the host to sign each call.
 * Scope: Pure construction plus one injected `fetch` and one injected `authorize` (the host signs a short-lived service assertion). Reads no env and holds no key.
 * Invariants:
 *   - ALIAS_FROM_SERVER_CONFIG: targets come only from the deployment's Git config (`.cogni/service-links.yaml`, parsed by `parseLinkTargets` in `@cogni-dao/agent-grants`); an alias that is not listed is `unknown_alias`. The model names an alias, never a URL.
 *   - GET_ONLY_CONFIGURED_ORIGIN: every request is a GET to `{origin}/api/v1/knowledge/{id}`, `{origin}/api/v1/knowledge?domain&q&limit` (list and search) or
 *     `{origin}/api/v1/knowledge/index?domain&q&limit` (the routing projection: id, domain, entryType and trigger, no content), https only, the configured origin only.
 *     Redirects are never followed (`redirect: "manual"`; any 3xx is `unavailable`). 10 s timeout. The body is capped at 1 MiB while it streams.
 *   - NO_HEADERS_BACK: only parsed knowledge rows leave the transport; no response header is returned or logged.
 *   - REDACT_SECRET_SHAPES: any `cogni_ag_sk_` key or JWT-shaped string in a body is replaced before the body is parsed.
 *   - ASK_ON_401: a 401 to a signed assertion sends ONE signed access ask (see `askForAccess`) and the tools answer the fixed `access_requested` result; a 403 is `policy_denied` and never asks.
 *   - DENIAL_IS_FIXED: a 401 (when no ask went out) or 403 from the target is `policy_denied`, which the tools turn into one fixed non-retryable receipt; nothing from the target's body is passed on. Every other
 *     failure (5xx, timeout, network, oversized body) is retryable `unavailable`.
 *   - ID_IS_CHECKED: a model-chosen id must match `REMOTE_KNOWLEDGE_ID_PATTERN` before a URL is built. BOUNDED_CONTENT: each entry's content is cut to `REMOTE_ENTRY_CONTENT_MAX_CHARS`.
 *   - CAPABILITY_INJECTION (tool-credential-brokering): no connection id or credential is a tool argument; the Authorization header exists only inside `fetch`.
 * Side-effects: IO (HTTPS GET to a configured node)
 * Links: https://node-template.cognidao.org/knowledge/tool-credential-brokering, https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { type KnowledgeEntry, KnowledgeRowSchema } from "@cogni-dao/knowledge-store/contracts";
import { z } from "zod";

/** One configured remote node: the alias a tool names, the node id the assertion's `aud` carries, and the target's canonical https origin. */
export interface RemoteKnowledgeTarget {
  readonly alias: string;
  readonly nodeId: string;
  readonly origin: string;
}

/** The alias a tool may name. */
export const REMOTE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The scope every remote knowledge read asks for (and the signed assertion carries). */
export const REMOTE_KNOWLEDGE_SCOPE = "knowledge:read";

/** The service slug the host signs as (`sub`). */
export const REMOTE_KNOWLEDGE_SERVICE = "node-ai";

export const REMOTE_TIMEOUT_MS = 10_000;
export const REMOTE_MAX_BODY_BYTES = 1024 * 1024;
/** Each remote entry's `content` is cut to this many characters before it reaches the model. */
export const REMOTE_ENTRY_CONTENT_MAX_CHARS = 64 * 1024;

/** A knowledge id the transport will put in a URL: an alphanumeric start, then letters, digits, dot, dash, underscore; never `.` or `..`. */
export const REMOTE_KNOWLEDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/** The path of a target's public service-enrollment route: where this node's AI asks for access. */
export const REMOTE_ENROLLMENT_PATH = "/api/v1/public/agent/service-enrollments";
/** At most one access ask per (alias, scope) per this many milliseconds, per process. */
export const REMOTE_ASK_INTERVAL_MS = 10 * 60_000;

/** The one message a model sees when an ask for access went out. */
export const ACCESS_REQUESTED_MESSAGE = "Access requested; an admin of that node must turn it On.";

export type RemoteKnowledgeErrorCode = "unknown_alias" | "invalid_id" | "access_requested" | "policy_denied" | "unavailable";

const FIXED_MESSAGE: Record<RemoteKnowledgeErrorCode, string> = {
  unknown_alias: "Unknown node alias",
  invalid_id: "Invalid knowledge id",
  access_requested: ACCESS_REQUESTED_MESSAGE,
  policy_denied: "Tool call denied by policy",
  unavailable: "Remote knowledge is unavailable",
};

/**
 * A refusal from the remote read. ONLY `policy_denied` (the target's 401 or 403) carries a non-retryable receipt (the tool runner keeps only a structured, bounded one), so the
 * model is told once and the call is never retried. `unavailable` (a 5xx, a timeout, a network failure, an oversized or unreadable body) is retryable: it has no receipt. The message
 * is always one of four fixed strings.
 */
export class RemoteKnowledgeError extends Error {
  readonly code: RemoteKnowledgeErrorCode;
  readonly receipt?: { readonly code: string; readonly retryable: false; readonly lookup: Record<string, string | null> };
  constructor(code: RemoteKnowledgeErrorCode, alias: string | null) {
    super(FIXED_MESSAGE[code]);
    this.name = "RemoteKnowledgeError";
    this.code = code;
    if (code === "policy_denied") this.receipt = { code, retryable: false, lookup: { tool: "remote_knowledge", node: alias } };
  }
}

/** One routing row of a remote node's knowledge index: no content, only what an agent needs to pick an entry. `useWhen` is the retrieval trigger (null until backfilled). */
export interface RemoteKnowledgeIndexRow {
  readonly id: string;
  readonly domain: string;
  readonly entryType: string;
  readonly useWhen: string | null;
}

const IndexRowSchema = z.object({ id: z.string(), domain: z.string(), entryType: z.string(), useWhen: z.string().nullable() });

/** The most rows an index read asks for (the target's own cap). */
export const REMOTE_INDEX_MAX_LIMIT = 1000;

export interface RemoteKnowledgeCapability {
  /** The configured origin of an alias (for source provenance), or undefined when the alias is not configured. */
  originOf(alias: string): string | undefined;
  get(alias: string, id: string): Promise<KnowledgeEntry | null>;
  list(alias: string, params: { domain: string; limit: number }): Promise<KnowledgeEntry[]>;
  search(alias: string, params: { domain: string; query: string; limit: number }): Promise<KnowledgeEntry[]>;
  /** The routing projection of the target's knowledge (`GET /api/v1/knowledge/index`): id, domain, entryType and trigger per entry, no content. `q` matches the trigger only. */
  index(alias: string, params: { domain?: string | undefined; q?: string | undefined; limit: number }): Promise<RemoteKnowledgeIndexRow[]>;
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

const SECRET_SHAPES: readonly RegExp[] = [
  /cogni_ag_sk_[A-Za-z0-9_-]+/g,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
];

/** Replace every secret-shaped string (an agent key, a JWT) with a fixed marker. */
export function redactSecretShapes(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[REDACTED]");
  return out;
}

/** The body as text, or null when it is missing or longer than `maxBytes` (counted while it streams, so an oversized body is never held). */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createRemoteKnowledgeTransport(deps: {
  readonly targets: readonly RemoteKnowledgeTarget[];
  /** The host signs one short-lived assertion for this target and scope and returns the whole `Authorization` header value. Called once per request. */
  readonly authorize: (target: RemoteKnowledgeTarget, scope: string) => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  /** Epoch milliseconds; default `Date.now`. Only the ask rate bound reads it. */
  readonly now?: () => number;
  /** Called after each access ask this transport sends: alias, scope and the target's HTTP status (null when it could not be reached). Never a token. */
  readonly onAsked?: (event: { alias: string; scope: string; httpStatus: number | null }) => void;
}): RemoteKnowledgeCapability {
  const targets = new Map(deps.targets.filter((t) => isCanonicalHttpsOrigin(t.origin)).map((t) => [t.alias, t]));
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REMOTE_TIMEOUT_MS;
  const maxBytes = deps.maxBodyBytes ?? REMOTE_MAX_BODY_BYTES;

  /**
   * ASK_ON_401: a signed node-ai assertion the target answers 401 (no principal yet, not enrolled) means this node's AI has not asked. The transport then sends ONE signed ask for
   * `knowledge:read` to the target's public enrollment route, at most once per (alias, scope) per `REMOTE_ASK_INTERVAL_MS` per process (memory only; the target also keeps one pending ask per
   * principal). Returns `requested` when an ask is outstanding (just sent, or sent within the interval and accepted) and `refused` when the ask did not go through (the target refused or could not be
   * reached), so the model is never told access was requested when it was not. A 403 never asks: that is a decision, not a missing ask.
   */
  const asked = new Map<string, { at: number; ok: boolean }>();
  const now = deps.now ?? Date.now;
  async function askForAccess(target: RemoteKnowledgeTarget): Promise<"requested" | "refused"> {
    const key = `${target.alias}\u0000${REMOTE_KNOWLEDGE_SCOPE}`;
    const before = asked.get(key);
    if (before && now() - before.at < REMOTE_ASK_INTERVAL_MS) return before.ok ? "requested" : "refused";
    // Recorded before the call, so concurrent 401s send one ask.
    asked.set(key, { at: now(), ok: false });
    let httpStatus: number | null = null;
    let ok = false;
    try {
      const authorization = await deps.authorize(target, REMOTE_KNOWLEDGE_SCOPE);
      const response = await doFetch(new URL(REMOTE_ENROLLMENT_PATH, target.origin).href, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization },
        body: JSON.stringify({ scope: REMOTE_KNOWLEDGE_SCOPE }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      httpStatus = response.status;
      ok = response.ok;
      await response.body?.cancel().catch(() => undefined);
    } catch {
      ok = false;
    }
    asked.set(key, { at: now(), ok });
    deps.onAsked?.({ alias: target.alias, scope: REMOTE_KNOWLEDGE_SCOPE, httpStatus });
    return ok ? "requested" : "refused";
  }

  /** One GET. Returns the parsed JSON body, or null for a 404. Throws `RemoteKnowledgeError`. */
  async function getJson(alias: string, path: string, query?: URLSearchParams): Promise<unknown | null> {
    const target = targets.get(alias);
    if (!target) throw new RemoteKnowledgeError("unknown_alias", null);
    const url = new URL(path, target.origin);
    if (query) url.search = query.toString();
    // The URL is built from the configured origin and a fixed path; this keeps it so even if a path segment were to carry authority characters.
    if (url.origin !== target.origin || url.protocol !== "https:") throw new RemoteKnowledgeError("unavailable", alias);
    let response: Response;
    try {
      const authorization = await deps.authorize(target, REMOTE_KNOWLEDGE_SCOPE);
      response = await doFetch(url.href, {
        method: "GET",
        headers: { accept: "application/json", authorization },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RemoteKnowledgeError("unavailable", alias);
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteKnowledgeError((await askForAccess(target)) === "requested" ? "access_requested" : "policy_denied", alias);
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteKnowledgeError("policy_denied", alias);
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    // Any 3xx (never followed), 5xx or other status is unavailable; nothing of the body is read.
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteKnowledgeError("unavailable", alias);
    }
    let text: string | null;
    try {
      text = await readBodyCapped(response, maxBytes);
    } catch {
      throw new RemoteKnowledgeError("unavailable", alias);
    }
    if (text === null) throw new RemoteKnowledgeError("unavailable", alias);
    try {
      return JSON.parse(redactSecretShapes(text)) as unknown;
    } catch {
      throw new RemoteKnowledgeError("unavailable", alias);
    }
  }

  const capContent = (row: KnowledgeEntry): KnowledgeEntry =>
    row.content.length > REMOTE_ENTRY_CONTENT_MAX_CHARS ? { ...row, content: `${row.content.slice(0, REMOTE_ENTRY_CONTENT_MAX_CHARS)}…` } : row;

  const rows = (body: unknown): KnowledgeEntry[] => {
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      const parsed = KnowledgeRowSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  };

  return {
    originOf: (alias) => targets.get(alias)?.origin,
    async get(alias, id) {
      if (!targets.has(alias)) throw new RemoteKnowledgeError("unknown_alias", null);
      // Checked before any URL is built or any assertion is signed: the id is model-chosen text.
      if (!REMOTE_KNOWLEDGE_ID_PATTERN.test(id) || id === "." || id === "..") throw new RemoteKnowledgeError("invalid_id", alias);
      const body = await getJson(alias, `/api/v1/knowledge/${encodeURIComponent(id)}`);
      if (body === null) return null;
      const parsed = KnowledgeRowSchema.safeParse(body);
      return parsed.success ? capContent(parsed.data) : null;
    },
    async list(alias, { domain, limit }) {
      const body = await getJson(alias, "/api/v1/knowledge", new URLSearchParams({ domain, limit: String(limit) }));
      return rows(body).slice(0, limit).map(capContent);
    },
    async index(alias, { domain, q, limit }) {
      const query = new URLSearchParams({ limit: String(Math.min(REMOTE_INDEX_MAX_LIMIT, Math.max(1, Math.floor(limit)))) });
      if (domain) query.set("domain", domain);
      if (q) query.set("q", q.slice(0, 320));
      const body = await getJson(alias, "/api/v1/knowledge/index", query);
      const items = (body as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) return [];
      return items
        .flatMap((item) => {
          const parsed = IndexRowSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
        .slice(0, limit)
        .map((r) => (r.useWhen !== null && r.useWhen.length > REMOTE_ENTRY_CONTENT_MAX_CHARS ? { ...r, useWhen: `${r.useWhen.slice(0, REMOTE_ENTRY_CONTENT_MAX_CHARS)}…` } : r));
    },
    async search(alias, { domain, query, limit }) {
      const body = await getJson(
        alias,
        "/api/v1/knowledge",
        new URLSearchParams({ domain, q: query, limit: String(Math.min(100, Math.max(limit, 1) * 5)) })
      );
      // The target may not filter on `q`: the match is repeated here, so the answer is the same either way.
      const needle = query.toLowerCase();
      return rows(body)
        .filter((row) => row.title.toLowerCase().includes(needle) || row.content.toLowerCase().includes(needle))
        .slice(0, limit)
        .map(capContent);
    },
  };
}
