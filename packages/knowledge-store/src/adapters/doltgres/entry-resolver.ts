// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/entry-resolver`
 * Purpose: Pins a cited hub atom to the commit that held it, for the work-items `EntryResolver` port (task.0086).
 * Scope: Lock-free reads on the caller's pooled client. Does not write, checkout a branch, or take a writer lock.
 * Invariants:
 *   - NO_CHECKOUT: every read is `AS OF` a commit hash; no `dolt_checkout`, so it never waits on the writer lock a patch holds.
 *   - NO_DOLT_DIFF: the `dolt_diff()` table function panics on Doltgres 0.57.3; it is never used.
 *   - PIN_MATCHES_READ: a main pin is the `dolt_hashof('main')` that the id read used; an inbox pin is the open contribution's `head_commit` that its id read used.
 *   - UNRESOLVED_IS_BY_ID: an unknown id, a closed or unknown inbox, or an inbox without the id is an `EntryUnresolvedError` listing those ids.
 *   - COMMIT_SHAPE: a hash is validated against `^[0-9a-v]{32}$` before it is placed in SQL.
 *   - ABORT_IS_HONORED: an aborted signal stops further reads.
 * Side-effects: IO (reads)
 * Links: hub change-history-design, packages/work-items/src/cites.ts
 * @public
 */

import {
  type EntryCiteRef,
  type EntryResolver,
  type EntryResolverRule,
  type ResolvedEntry,
  EntryUnresolvedError,
} from "../../port/entry-resolver.port.js";
import { escapeValue } from "./util.js";

const COMMIT = /^[0-9a-v]{32}$/;

/** A postgres.js-shaped executor; only `unsafe` is used, with escaped values. */
export interface EntryResolverSql {
  unsafe(query: string): PromiseLike<readonly Record<string, unknown>[]>;
}

function commitOf(value: unknown, what: string): string {
  const commit = String(value ?? "");
  if (!COMMIT.test(commit)) throw new Error(`${what} is not a Dolt commit hash`);
  return commit;
}

function idList(ids: readonly string[]): string {
  return ids.map((id) => escapeValue(id)).join(", ");
}

/** The ids that exist in `knowledge` as of `commit`. */
async function idsAsOf(
  sql: EntryResolverSql,
  commit: string,
  ids: readonly string[]
): Promise<Set<string>> {
  const rows = await sql.unsafe(
    `SELECT id FROM knowledge AS OF '${commit}' WHERE id IN (${idList(ids)})`
  );
  return new Set(rows.map((row) => String(row.id)));
}

export function createDoltgresEntryResolver(sql: EntryResolverSql): EntryResolver {
  return {
    async resolve(
      refs: readonly EntryCiteRef[],
      rule: EntryResolverRule,
      signal: AbortSignal
    ): Promise<readonly ResolvedEntry[]> {
      if (rule !== "cite") throw new Error(`Unknown entry resolution rule: ${String(rule)}`);
      const live = () => signal.throwIfAborted();
      live();
      const resolved: ResolvedEntry[] = [];
      const unresolved: string[] = [];

      const plain = refs.filter((ref) => !ref.contribution);
      if (plain.length) {
        const hashRows = await sql.unsafe("SELECT dolt_hashof('main') AS hash");
        const hash = commitOf(hashRows[0]?.hash, "main");
        live();
        const found = await idsAsOf(sql, hash, plain.map((r) => r.id));
        for (const ref of plain) {
          if (found.has(ref.id))
            resolved.push({ id: ref.id, commit: hash, plane: "main" });
          else unresolved.push(ref.id);
        }
      }

      const inbox = refs.filter((ref) => ref.contribution);
      if (inbox.length) {
        live();
        const contributions = [...new Set(inbox.map((r) => r.contribution as string))];
        const rows = await sql.unsafe(
          `SELECT id, state, head_commit FROM knowledge_contributions WHERE id IN (${idList(contributions)})`
        );
        const heads = new Map<string, string>();
        for (const row of rows) {
          if (row.state === "open" && row.head_commit != null) {
            heads.set(String(row.id), commitOf(row.head_commit, "head_commit"));
          }
        }
        // One read per distinct inbox head, in request order.
        const byContribution = new Map<string, EntryCiteRef[]>();
        for (const ref of inbox) {
          const list = byContribution.get(ref.contribution as string) ?? [];
          list.push(ref);
          byContribution.set(ref.contribution as string, list);
        }
        for (const [contribution, group] of byContribution) {
          const head = heads.get(contribution);
          if (!head) {
            unresolved.push(...group.map((r) => r.id));
            continue;
          }
          live();
          const found = await idsAsOf(sql, head, group.map((r) => r.id));
          for (const ref of group) {
            if (found.has(ref.id))
              resolved.push({ id: ref.id, commit: head, plane: "inbox", contribution });
            else unresolved.push(ref.id);
          }
        }
      }

      if (unresolved.length) throw new EntryUnresolvedError(unresolved);
      return resolved;
    },
  };
}
