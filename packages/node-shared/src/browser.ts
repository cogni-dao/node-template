// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/node-shared/browser`
 * Purpose: Browser-safe exports for consumers of the shared package.
 * Scope: Pure utilities, constants and types. Node crypto and request-local auth stay on the server entry.
 * Invariants: No Node builtins in this entry's runtime dependency graph.
 * Side-effects: none
 * Links: src/index.ts, package.json
 * @public
 */

export * from "./ai/guards";
export * from "./ai/tool-catalog";
export * from "./analytics";
export type {
	FailedLinkIntent,
	LinkIntent,
	PendingLinkIntent,
} from "./auth/link-intent-store";
export type * from "./auth/session";
export * from "./constants";
export * from "./errors";
export * from "./observability";
export * from "./schemas/litellm.spend-logs.schema";
export * from "./time/time-range";
export * from "./util";
export * from "./utils/money";
export * from "./web3";
