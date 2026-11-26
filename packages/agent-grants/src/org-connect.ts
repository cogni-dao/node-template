// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/service-auth` neighbours: the org's side of connect and disconnect (task.0181)
 * Purpose: The org's node tells another node "I am this org" server to server: it reads the target's node id from its discovery document, signs a short-lived service assertion
 *   (service `org-connect`, scope `org:connect` or `org:disconnect`, audience the target's node id) and POSTs it. The target answers with the account's status, which the org's node
 *   keeps in `org_connections` so its governance page can show it (including `suspended`). The target then pulls the statement itself; nothing else is sent, no code is shown or pasted.
 * Scope: Raw SQL over an injected tag, an injected signer and fetch. The caller (the node's admin session) has already decided the person may act for the org.
 * Invariants:
 *   - DIRECTORY_ONLY: only an origin the fleet directory lists is fetched or posted to, and the audience node id is the DIRECTORY's, never the target's own claim. The target's
 *     `agent.json` must agree (a different `nodeId` is `wrong_node`, nothing is sent). No redirects, 10 s, 64 KiB.
 *   - NO_SIGNER_NO_CALL: without a signer nothing is sent (`no_signer`).
 *   - NO_TOKEN_IN_ERRORS: the assertion never appears in a result, error or log.
 *   - STATUS_IS_THE_TARGETS: a reachable target's answer is stored as is; any failure is `unreachable` with a short reason code.
 * Side-effects: IO (HTTPS to the target, SQL)
 * Links: https://node-template.cognidao.org/knowledge/org-fleet-identity (Connecting an org to another node)
 * @public
 */

import { isCanonicalOrgOrigin } from "./orgs";
import { ORG_CONNECT_SCOPE, ORG_CONNECT_SERVICE, ORG_DISCONNECT_SCOPE } from "./org-http";
import { OrgAccountError } from "./org-accounts";
import type { SqlTag } from "./postgres";
import { readTextCapped, type ServiceAssertionSigner } from "./service-auth";

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 100;

export type ConnectionStatus = "connected" | "disconnected" | "suspended" | "unreachable";

export interface OrgConnection {
  readonly origin: string;
  readonly name: string;
  readonly status: ConnectionStatus;
  readonly reason: string | null;
}

/** One node the fleet directory lists: its canonical https origin and its node id (the audience of a signed connect). */
export interface OrgDirectoryEntry {
  readonly origin: string;
  readonly nodeId: string;
}

/** The directory entry for an origin (a trailing slash is ignored), or null. The directory is the node's repo config today (`.cogni/service-links.yaml`). */
export function directoryEntry(directory: readonly OrgDirectoryEntry[], origin: string): OrgDirectoryEntry | null {
  const wanted = typeof origin === "string" ? origin.trim().replace(/\/+$/, "") : "";
  return isCanonicalOrgOrigin(wanted) ? (directory.find((entry) => entry.origin === wanted) ?? null) : null;
}

export interface OutboundDeps {
  /** The fleet directory: an origin outside it is `not_in_directory` and nothing is sent. */
  readonly directory: readonly OrgDirectoryEntry[];
  readonly sql: SqlTag;
  /** The org node's signer, or null while none is configured. */
  readonly signer: () => Promise<Pick<ServiceAssertionSigner, "authorizationHeader"> | null>;
  readonly fetch?: typeof fetch | undefined;
  /** The version of THIS node's statement (its build's commit time). Without one nothing is sent (`unversioned`): a node signs no statement without a build time. Recorded as the connection's acknowledged version only when the target answers it holds one at least this high. */
  readonly version?: number | undefined;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readTextCapped(res, MAX_BODY_BYTES));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The longest reason kept: it is a short code or the target's own word, never a body. */
const MAX_REASON_CHARS = 500;

async function remember(
  sql: SqlTag,
  input: { origin: string; nodeId: string; status: ConnectionStatus; reason: string | null; by: string; version: number | null; op: "connect" | "disconnect" }
): Promise<void> {
  // GREATEST, never COALESCE: an acknowledgement is never lowered (GREATEST ignores a null side).
  await sql`
    INSERT INTO org_connections (origin, node_id, status, reason, updated_by, updated_at, statement_version, last_op)
    VALUES (${input.origin}, ${input.nodeId}, ${input.status}, ${input.reason?.slice(0, MAX_REASON_CHARS) ?? null}, ${input.by}, now(), ${input.version}::bigint, ${input.op})
    ON CONFLICT (origin) DO UPDATE SET node_id = EXCLUDED.node_id, status = EXCLUDED.status, reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by, updated_at = now(),
      statement_version = GREATEST(org_connections.statement_version, EXCLUDED.statement_version), last_op = EXCLUDED.last_op`;
}

/** The nodes this org connected to, with the status each last answered, keyset-paged by origin (`after` is the previous page's `next`; `next` is null on the last page). */
export async function listOrgConnections(
  sql: SqlTag,
  after?: string | null,
  /**
   * `statuses`: only these. `below`: only connections whose acknowledged statement version is unknown or lower. `connectsOnly`: an `unreachable` row counts only when its LAST operation was a connect
   * (never one the org was disconnecting). The boot re-post uses all three.
   */
  filter?: { statuses?: readonly ConnectionStatus[]; below?: number; connectsOnly?: boolean }
): Promise<{ connections: OrgConnection[]; next: string | null }> {
  const statuses = filter?.statuses ? [...filter.statuses] : null;
  const below = filter?.below ?? null;
  const connectsOnly = filter?.connectsOnly === true;
  const rows = await sql`
    SELECT origin, status, reason FROM org_connections
    WHERE origin > ${after ?? ""}
      AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
      AND (${below}::bigint IS NULL OR statement_version IS NULL OR statement_version < ${below}::bigint)
      AND (NOT ${connectsOnly}::boolean OR status <> 'unreachable' OR last_op = 'connect')
    ORDER BY origin LIMIT ${MAX_CONNECTIONS + 1}`;
  return {
    connections: rows.slice(0, MAX_CONNECTIONS).map((row) => ({
      origin: String(row.origin),
      name: new URL(String(row.origin)).host,
      status: String(row.status) as ConnectionStatus,
      reason: typeof row.reason === "string" ? row.reason : null,
    })),
    next: rows.length > MAX_CONNECTIONS && rows[MAX_CONNECTIONS - 1] ? String(rows[MAX_CONNECTIONS - 1]?.origin) : null,
  };
}

async function call(deps: OutboundDeps, rawOrigin: string, op: "connect" | "disconnect", by: string, refresh = false): Promise<OrgConnection> {
  const entry = directoryEntry(deps.directory, rawOrigin);
  if (!entry) throw new OrgAccountError("not_in_directory", "origin is not in the fleet directory");
  const origin = entry.origin;
  if (op === "connect" && !deps.version) throw new OrgAccountError("unversioned", "this build has no build time, so it signs no statement and connects to no node");
  const signer = await deps.signer();
  if (!signer) throw new OrgAccountError("no_signer", "no signing key is configured");
  const doFetch = deps.fetch ?? fetch;
  const name = new URL(origin).host;
  const nodeId = entry.nodeId;
  let status: ConnectionStatus = "unreachable";
  let reason: string | null = null;
  let ackable = false;
  try {
    // The target's own claim must agree with the directory; the audience is always the directory's id.
    const discovery = await doFetch(new URL("/.well-known/agent.json", origin), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
    if (!discovery.ok) {
      await discovery.body?.cancel().catch(() => undefined);
      throw new Error("discovery unreachable");
    }
    const doc = await readJson(discovery);
    // FAIL_CLOSED: the target must CONFIRM the directory's node id. A discovery document with no node id (an older node) is `wrong_node`, and nothing is signed.
    if (typeof doc?.nodeId !== "string" || doc.nodeId !== nodeId) throw new OrgAccountError("wrong_node", "the node's id could not be confirmed against the directory");
    const authorization = await signer.authorizationHeader({
      service: ORG_CONNECT_SERVICE,
      audienceNodeId: nodeId,
      scope: op === "connect" ? ORG_CONNECT_SCOPE : ORG_DISCONNECT_SCOPE,
    });
    const res = await doFetch(new URL(`/api/v1/public/orgs/${op}`, origin), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await readJson(res);
    if (res.ok && (body?.status === "connected" || body?.status === "disconnected" || body?.status === "suspended")) {
      status = body.status;
      reason = typeof body.reason === "string" ? body.reason : null;
      // ACK_ONLY_WHAT_WAS_APPLIED: the target says whether it applied the statement and which version it holds; only a held version at least ours is an acknowledgement.
      ackable = body.applied === true && typeof body.version === "number" && Number.isSafeInteger(body.version) && deps.version !== undefined && body.version >= deps.version;
    } else {
      reason = res.ok ? "bad_answer" : typeof body?.error === "string" ? String(body.error).slice(0, 60) : `http_${res.status}`;
    }
  } catch (error) {
    if (error instanceof OrgAccountError) throw error;
    reason = "unreachable";
  }
  const acknowledged = status === "connected" && op === "connect" && ackable ? (deps.version ?? null) : null;
  if (!refresh) await remember(deps.sql, { origin, nodeId, status, reason, by, version: acknowledged, op });
  // A refresh (the org's own statement changed, no admin acted) only updates what the target last answered, for a connection that exists; `by` is then the org's service principal.
  else
    await deps.sql`UPDATE org_connections SET status = ${status}, reason = ${reason?.slice(0, MAX_REASON_CHARS) ?? null}, updated_by = ${by}, updated_at = now(),
      statement_version = GREATEST(statement_version, ${acknowledged}::bigint) WHERE origin = ${origin}`;
  return { origin, name, status, reason };
}

/** Connect to the node at `origin`: send the signed connect; the target pulls the statement and answers with the account's status. */
export const connectOrgOutbound = (deps: OutboundDeps, origin: string, by: string): Promise<OrgConnection> => call(deps, origin, "connect", by);

/**
 * RE-POST CONNECT: the org's admin facts changed (an approver was added or removed), or this node just booted a new build, so ask a node to pull the statement now (best effort: a node that is down
 * learns it at its next statement read, within its cache window). No acting admin: `by` is the org's own
 * service principal (`orgActor`), written to `updated_by` with the new status. The node refuses it as it refuses any connect (directory, node id).
 */
export const refreshOrgOutbound = (deps: OutboundDeps, origin: string, by: string): Promise<OrgConnection> => call(deps, origin, "connect", by, true);

/** Disconnect from the node at `origin`: send the signed disconnect; the org's services stop at that node's next call. */
export const disconnectOrgOutbound = (deps: OutboundDeps, origin: string, by: string): Promise<OrgConnection> => call(deps, origin, "disconnect", by);
