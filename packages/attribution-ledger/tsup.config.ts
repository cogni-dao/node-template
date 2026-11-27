// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/tsup.config`
 * Purpose: Build configuration for ledger-core package.
 * Scope: Build tooling only. Does not contain runtime code.
 * Invariants: Output must be ESM with type declarations.
 * Side-effects: IO
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/attribution-ledger.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: [
    "src/fixtures.ts",
    "src/distribution/publish-permission.ts",
    "src/adapters/postgres.ts",
    "src/presentation.ts",
    "src/allocation.ts",
    "src/collect/activities/enrichment.ts",
    "src/collect/activities/ledger.ts",
    "src/collect/contract.ts",
    "src/collect/index.ts",
    "src/collect/run-collect-pass.ts",
    "src/collect/sources/index.ts",
    "src/collect/sources/model.ts",
    "src/collect/sources/port.ts",
    "src/contracts/attribution.collect-trigger.v1.contract.ts",
    "src/contracts/attribution.epoch-activity.v1.contract.ts",
    "src/contracts/attribution.epoch-claimants.v1.contract.ts",
    "src/contracts/attribution.epoch-distribution.v1.contract.ts",
    "src/contracts/attribution.epoch-statement.v1.contract.ts",
    "src/contracts/attribution.epoch-user-projections.v1.contract.ts",
    "src/contracts/attribution.finalize-epoch.v1.contract.ts",
    "src/contracts/attribution.latest-distribution.v1.contract.ts",
    "src/contracts/attribution.list-epochs.v1.contract.ts",
    "src/contracts/attribution.receipts.internal.v1.contract.ts",
    "src/contracts/attribution.record-pool-component.v1.contract.ts",
    "src/contracts/attribution.review-epoch.v1.contract.ts",
    "src/contracts/attribution.review-subject-overrides.v1.contract.ts",
    "src/contracts/attribution.settlement-lifecycle.v1.contract.ts",
    "src/contracts/attribution.sign-data.v1.contract.ts",
    "src/contracts/attribution.sign-data.v2.contract.ts",
    "src/contracts/index.ts",
    "src/distribution/epoch-distribution-service.ts",
    "src/distribution/index.ts",
    "src/distribution/token-distribution.ts",
    "src/distribution/token-settlement.ts",
    "src/distribution/types.ts",
    "src/distribution/wallet-resolver.ts",
    "src/epoch-window.ts",
    "src/http/index.ts",
    "src/index.ts",
    "src/pipeline/contracts/allocator.ts",
    "src/pipeline/contracts/enricher.ts",
    "src/pipeline/contracts/index.ts",
    "src/pipeline/contracts/ordering.ts",
    "src/pipeline/contracts/profile.ts",
    "src/pipeline/contracts/selection.ts",
    "src/pipeline/contracts/validation.ts",
    "src/pipeline/finalize/run-finalize-epoch.ts",
    "src/pipeline/index.ts",
    "src/pipeline/plugins/echo/adapter.ts",
    "src/pipeline/plugins/echo/descriptor.ts",
    "src/pipeline/plugins/include-all-selection/descriptor.ts",
    "src/pipeline/plugins/main-merge-selection/descriptor.ts",
    "src/pipeline/plugins/promotion-selection/descriptor.ts",
    "src/pipeline/plugins/weight-sum/descriptor.ts",
    "src/pipeline/profiles/cogni-v0.0.ts",
    "src/pipeline/registry.ts",
    "src/pipeline/settlement/governance-target-guard.ts",
    "src/pipeline/settlement/run-reconcile-settlements.ts",
    "src/schema.ts",
  ],
  format: ["esm"],
  splitting: true, // one shared chunk keeps typed-error identity across entrypoints
  dts: false, // tsc -b emits per-file declarations; tsup handles JS only
  clean: false, // preserve .d.ts files from tsc -b (incremental builds)
  sourcemap: true,
  platform: "neutral",
});

export default tsupConfig;
