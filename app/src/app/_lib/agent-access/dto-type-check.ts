// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/agent-access/dto-type-check`
 * Purpose: A compile-time guard that the zod DTO the roles route sends (`@cogni/node-contracts`) and the view type the
 *   "This node's AI" block reads (`NodeAiAccessView`, `@cogni-dao/agent-grants`) are the same shape. `pnpm typecheck`
 *   compiles this file (tsconfig.app.json includes src/**), so drift between the two breaks the build.
 * Scope: Types and two never-called functions. No runtime behavior.
 * Invariants: Both directions are checked. Wire -> view proves the route sends everything the view needs. View -> wire
 *   proves the view has no field the wire lacks. Key sets are compared at every level, so an added or renamed field on
 *   either side fails here.
 * Side-effects: none
 * Links: tests/unit/app/agent-access-wiring.test.ts, review J1 (the contract and the view type should become one package type)
 * @internal
 */

import type { NodeAiAccessView } from "@cogni/agent-grants";
import type { agentRolesListOperation } from "@cogni/node-contracts";
import type { z } from "zod";

type Wire = z.infer<typeof agentRolesListOperation.output>;

/** `true` only when A and B have exactly the same keys; otherwise `never`, which makes the assignment below fail. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : never
  : never;

const topKeys: SameKeys<Wire, NodeAiAccessView> = true;
const aiKeys: SameKeys<Wire["ai"][number], NodeAiAccessView["ai"][number]> = true;
const jobKeys: SameKeys<
  Wire["ai"][number]["jobs"][number],
  NodeAiAccessView["ai"][number]["jobs"][number]
> = true;

/** Wire -> view: the DTO the route sends is accepted wherever the view type is expected (types only). */
export function wireIsView(wire: Wire): NodeAiAccessView {
  return wire;
}

/** View -> wire: the view type carries no field the DTO lacks (the view is readonly, the DTO is not, so rebuild it). */
export function viewIsWire(view: NodeAiAccessView): Wire {
  return {
    canManage: view.canManage,
    ai: view.ai.map((ai) => ({
      principal: ai.principal,
      name: ai.name,
      blurb: ai.blurb,
      jobs: ai.jobs.map((job) => ({
        scope: job.scope,
        label: job.label,
        risk: job.risk,
        allowed: job.allowed,
      })),
    })),
  };
}

export const DTO_MATCHES_VIEW = [topKeys, aiKeys, jobKeys] as const;
