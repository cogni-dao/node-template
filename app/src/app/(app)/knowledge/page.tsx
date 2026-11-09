// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Authenticated dashboard shell. Seeds only the active tab with its canonical
 * wire response. Browse reads one bounded metadata window (with its exact
 * total), with no domain, legacy list, graph, Goals or Inbox reads. Graph is not
 * seeded: the client reads the whole corpus once per revision (ETag/304). Other
 * tabs retain their loaders.
 * @public
 */

import { GoalsProgressSchema } from "@cogni-dao/metrics/contracts";
import { redirect } from "next/navigation";

import { loadGoalsProgress } from "@/app/_facades/metrics.server";
import { getContainer } from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import {
  loadDomains,
  loadKnowledgeBrowse,
  loadKnowledgeListCached,
} from "./_server/loaders";
import { KnowledgeDashboardView } from "./view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A failed/unconfigured store must not 500 the page — degrade to a client
// fetch (which now shows an honest skeleton, never "0 entries").
async function safe<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  const port = getContainer().knowledgeStorePort;
  const { mode } = await searchParams;

  const goalsSeed =
    mode === "goals"
      ? safe(loadGoalsProgress()).then(
          (d) => GoalsProgressSchema.safeParse(d).data
        )
      : Promise.resolve(undefined);

  // Graph is not SSR-seeded: the whole-corpus payload is fetched once per store
  // revision and revalidated by ETag (304), which an HTML seed cannot do.
  const [initialBrowse, initialList, initialDomains] = port
    ? await Promise.all([
        !mode || mode === "browse"
          ? safe(loadKnowledgeBrowse(port))
          : undefined,
        mode === "chains"
          ? safe(loadKnowledgeListCached(port, { limit: 500 }))
          : undefined,
        mode === "domains" ? safe(loadDomains(port)) : undefined,
      ])
    : [undefined, undefined, undefined];
  const initialGoals = await goalsSeed;

  return (
    <KnowledgeDashboardView
      initialGoals={initialGoals}
      initialList={initialList}
      initialDomains={initialDomains}
      initialBrowse={initialBrowse}
    />
  );
}
