// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/remote-knowledge`
 * Purpose: Read another node's knowledge through the stock knowledge tools (story.0038 phase 2). The host builds ONE transport from server config; the tools only
 *   name a node alias. The transport, not the tool and not the model, holds the target list and asks the host to sign each call.
 * Scope: Pure construction plus one injected `fetch` and one injected `authorize` (the host signs a short-lived service assertion). Reads no env and holds no key.
 * Invariants:
 *   - ALIAS_FROM_SERVER_CONFIG: targets come only from the deployment's Git config (`.cogni/service-links.yaml`, parsed by `parseLinkTargets` in `@cogni-dao/agent-grants`); an alias that is not listed is `unknown_alias`. The model names an alias, never a URL.
 *   - GET_ONLY_CONFIGURED_ORIGIN: every request is a GET to `{origin}/api/v1/knowledge/{id}` or `{origin}/api/v1/knowledge?...`, https only, the configured origin only.
 *     Redirects are never followed (`redirect: "manual"`; any 3xx is `unavailable`). 10 s timeout. The body is capped at 1 MiB while it streams.
 *   - NO_HEADERS_BACK: only parsed knowledge rows leave the transport; no response header is returned or logged.
 *   - REDACT_SECRET_SHAPES: any `cogni_ag_sk_` key or JWT-shaped string in a body is replaced before the body is parsed.
 *   - DENIAL_IS_FIXED: a 401 or 403 from the target is `policy_denied`, which the tools turn into one fixed non-retryable receipt; nothing from the target's body is passed on.
 *   - CAPABILITY_INJECTION (tool-credential-brokering): no connection id or credential is a tool argument; the Authorization header exists only inside `fetch`.
 * Side-effects: IO (HTTPS GET to a configured node)
 * Links: https://node-template.cognidao.org/knowledge/tool-credential-brokering, https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { type KnowledgeEntry, KnowledgeRowSchema } from "@cogni-dao/knowledge-store/contracts";

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

export type RemoteKnowledgeErrorCode = "unknown_alias" | "policy_denied" | "unavailable";

const FIXED_MESSAGE: Record<RemoteKnowledgeErrorCode, string> = {
  unknown_alias: "Unknown node alias",
  policy_denied: "Tool call denied by policy",
  unavailable: "Remote knowledge is unavailable",
};

/**
 * A refusal from the remote read. `policy_denied` and `unavailable` carry a non-retryable receipt (the tool runner keeps only a structured, bounded one), so the
 * model is told once and the call is never retried. The message is always one of three fixed strings.
 */
export class RemoteKnowledgeError extends Error {
  readonly code: RemoteKnowledgeErrorCode;
  readonly receipt?: { readonly code: string; readonly retryable: false; readonly lookup: Record<string, string | null> };
  constructor(code: RemoteKnowledgeErrorCode, alias: string | null) {
    super(FIXED_MESSAGE[code]);
    this.name = "RemoteKnowledgeError";
    this.code = code;
    if (code !== "unknown_alias") this.receipt = { code, retryable: false, lookup: { tool: "remote_knowledge", node: alias } };
  }
}

export interface RemoteKnowledgeCapability {
  /** The configured origin of an alias (for source provenance), or undefined when the alias is not configured. */
  originOf(alias: string): string | undefined;
  get(alias: string, id: string): Promise<KnowledgeEntry | null>;
  list(alias: string, params: { domain: string; limit: number }): Promise<KnowledgeEntry[]>;
  search(alias: string, params: { domain: string; query: string; limit: number }): Promise<KnowledgeEntry[]>;
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
}): RemoteKnowledgeCapability {
  const targets = new Map(deps.targets.filter((t) => isCanonicalHttpsOrigin(t.origin)).map((t) => [t.alias, t]));
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REMOTE_TIMEOUT_MS;
  const maxBytes = deps.maxBodyBytes ?? REMOTE_MAX_BODY_BYTES;

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
    if (response.status === 401 || response.status === 403) {
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
      const body = await getJson(alias, `/api/v1/knowledge/${encodeURIComponent(id)}`);
      if (body === null) return null;
      const parsed = KnowledgeRowSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
    async list(alias, { domain, limit }) {
      const body = await getJson(alias, "/api/v1/knowledge", new URLSearchParams({ domain, limit: String(limit) }));
      return rows(body).slice(0, limit);
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
        .slice(0, limit);
    },
  };
}
