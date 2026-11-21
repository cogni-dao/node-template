// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** One scoped SQL snapshot returns complete global facts and at most one contributor page. No upstream IO. */
import { sql } from "drizzle-orm";
import type { AttributionSchema } from "../schema";
import {
  displayShare,
  type ContributorSummaryPage,
} from "../read/presentation";
import { EPOCH_PAGE_MAX_LIMIT } from "../read/epoch-views";
import type { ReadPage } from "../store";
import type { AttributionDatabase } from "./types";

interface SummaryRow {
  claimant_key: string;
  claimant_kind: "user" | "identity";
  user_id: string | null;
  source: string | null;
  platform_login: string | null;
  units: string;
  receipt_count: number;
}

export async function readLiveContributorSummaryPage(
  db: AttributionDatabase,
  tables: AttributionSchema,
  nodeId: string,
  scopeId: string,
  epochId: bigint,
  page: ReadPage
): Promise<ContributorSummaryPage> {
  // B1: projections, resolved-without-projection and unresolved selections are disjoint.
  // Eligibility uses the original weight so a zero review override retains its receipt and reset control.
  // Global totals are computed before LIMIT. No raw receipt history enters the process.
  const result = await db.execute<{
    items: SummaryRow[];
    total: number;
    total_units: string;
    total_points: string;
    total_receipt_count: number;
    unresolved_count: number;
    unresolved_activity_total: number;
    unresolved_activities: ContributorSummaryPage["unresolvedActivities"];
  }>(sql`
    WITH scoped_epoch AS (
      SELECT id, node_id, weight_config FROM ${tables.epochs}
      WHERE id = ${epochId} AND node_id = ${nodeId} AND scope_id = ${scopeId}
    ), selected_base AS (
      SELECT s.user_id, r.source, r.platform_user_id, r.platform_login,
        COALESCE(s.weight_override_milli, (e.weight_config ->> (r.source || ':' || r.event_type))::bigint, 0) AS base_units,
        o.override_units
      FROM ${tables.epochSelection} s JOIN scoped_epoch e ON e.id = s.epoch_id AND e.node_id = s.node_id
      JOIN ${tables.ingestionReceipts} r ON r.node_id = s.node_id AND r.receipt_id = s.receipt_id
      LEFT JOIN ${tables.epochReviewSubjectOverrides} o ON o.node_id = s.node_id AND o.epoch_id = s.epoch_id AND o.subject_ref = s.receipt_id
      WHERE s.included = true
    ), selected AS (
      SELECT *, COALESCE(override_units, base_units) AS units FROM selected_base
    ), unresolved AS (
      SELECT 'identity:' || source || ':' || platform_user_id AS claimant_key,
        source, MAX(platform_login) AS platform_login, COUNT(*)::int AS event_count
      FROM selected WHERE user_id IS NULL GROUP BY source, platform_user_id
    ), unresolved_totals AS (
      SELECT COALESCE(SUM(event_count),0)::int AS unresolved_count, COUNT(*)::int AS unresolved_activity_total FROM unresolved
    ), unresolved_page AS (
      SELECT claimant_key AS "claimantKey", source, platform_login AS "platformLogin", event_count AS "eventCount"
      FROM unresolved ORDER BY event_count DESC, claimant_key ASC LIMIT ${EPOCH_PAGE_MAX_LIMIT}
    ), projection_deltas AS (
      SELECT user_id, SUM(units - base_units) AS delta, MAX(platform_login) AS platform_login FROM selected WHERE user_id IS NOT NULL GROUP BY user_id
    ), projected AS (
      SELECT p.user_id, p.projected_units + COALESCE(d.delta,0) AS units, p.receipt_count, d.platform_login
      FROM ${tables.epochUserProjections} p JOIN scoped_epoch e ON e.id = p.epoch_id AND e.node_id = p.node_id
      LEFT JOIN projection_deltas d ON d.user_id = p.user_id
    ), fallback_sources AS (
      SELECT CASE WHEN s.user_id IS NOT NULL THEN 'user:' || s.user_id ELSE 'identity:' || s.source || ':' || s.platform_user_id END AS claimant_key,
        CASE WHEN s.user_id IS NOT NULL THEN 'user' ELSE 'identity' END AS claimant_kind,
        s.user_id, CASE WHEN s.user_id IS NULL THEN s.source ELSE NULL END AS source,
        s.platform_login, s.units
      FROM selected s WHERE s.base_units > 0 AND NOT EXISTS (SELECT 1 FROM projected p WHERE p.user_id = s.user_id)
    ), fallback AS (
      SELECT claimant_key, claimant_kind, user_id, source, MAX(platform_login) AS platform_login,
        SUM(units)::text AS units, COUNT(*)::int AS receipt_count
      FROM fallback_sources GROUP BY claimant_key, claimant_kind, user_id, source
    ), contributors AS (
      SELECT 'user:' || p.user_id AS claimant_key, 'user' AS claimant_kind, p.user_id,
        NULL::text AS source, p.platform_login, p.units::text AS units, p.receipt_count FROM projected p
      UNION ALL SELECT claimant_key, claimant_kind, user_id, source, platform_login, units, receipt_count FROM fallback
    ), totals AS (
      SELECT COUNT(*)::int AS total, COALESCE(SUM(units::numeric),0)::text AS total_units,
        COALESCE(SUM(trunc((units::numeric + 500) / 1000)),0)::text AS total_points,
        COALESCE(SUM(receipt_count),0)::int AS total_receipt_count FROM contributors
    ), page AS (
      SELECT * FROM contributors ORDER BY units::numeric DESC, claimant_key ASC LIMIT ${page.limit} OFFSET ${page.offset}
    )
    SELECT totals.total, totals.total_units, totals.total_points, totals.total_receipt_count,
      unresolved_totals.unresolved_count, unresolved_totals.unresolved_activity_total,
      COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u."eventCount" DESC, u."claimantKey" ASC) FROM unresolved_page u), '[]'::jsonb) AS unresolved_activities,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.units::numeric DESC, p.claimant_key ASC) FROM page p), '[]'::jsonb) AS items
    FROM totals CROSS JOIN unresolved_totals
  `);
  const row = result[0];
  const totalUnits = row?.total_units ?? "0";
  return {
    epochId: epochId.toString(),
    total: row?.total ?? 0,
    totalUnits,
    totalPoints: row?.total_points ?? "0",
    totalReceiptCount: row?.total_receipt_count ?? 0,
    unresolvedCount: row?.unresolved_count ?? 0,
    unresolvedActivityTotal: row?.unresolved_activity_total ?? 0,
    unresolvedActivities: row?.unresolved_activities ?? [],
    limit: page.limit,
    offset: page.offset,
    items: (row?.items ?? []).map((item) => ({
      claimantKey: item.claimant_key,
      claimantKind: item.claimant_kind,
      isLinked: item.claimant_kind === "user",
      displayName: item.platform_login?.trim() || null,
      claimantLabel:
        item.claimant_kind === "user"
          ? "Linked account"
          : `${item.source ?? "External"} account`,
      units: item.units,
      receiptCount: item.receipt_count,
      creditShare: displayShare(BigInt(item.units), BigInt(totalUnits)),
    })),
  };
}
