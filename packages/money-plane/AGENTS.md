# money-plane · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** draft
- **Last reviewed:** 2026-10-24

## Purpose

Published leaf package (`@cogni-dao/money-plane`, consumed as `@cogni/money-plane`) that owns the money-plane row model, grading policy, the never-throwing snapshot runner, and the generic injected readers for: Base wallets and the OpenRouter account. Design: [money-plane-snapshot-design](https://cognidao.org/knowledge/money-plane-snapshot-design).

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

No runtime dependencies, no env reads, no React, no viem. `fetch` is injected (`FetchLike`).

## Public Surface

- Types: `MoneyPlaneRow`, `NativeAmount`, `NativeRate`, `PayAction`, `Grade`, `PlaneKind`, `ReasonCode`, `PlaneReader`, `MoneyPlaneSnapshot`, `FetchLike`
- Policy: `RUNWAY_DAYS`, `SPEND_USD_PER_MONTH`, `EXPIRY_DAYS`, `ESCROW_DAYS`, `ESCROW_CALIBRATED`
- Grading: `gradeRunway`, `gradeSpend`, `gradeExpiry`, `worstGrade`, `applyGradingFloor`
- Reporting: `summarizeCostRates`, `CostRateBasis`, `CostRateEvidence`, `CostRateCohort`, `CostRateSummary` — exact rate cohorts separated by economic owner, scope, instrument, unit and contract/measured basis. Measured windows must match; unknown age and partial coverage remain explicit. No custody totals, FX, authorization or ledger.
- Runner: `takeSnapshot(readers, { timeoutMs, now? })`
- Readers: `openRouterReader`, `baseWalletReader`; helpers `unknownRow`, `safeDetail`

## Invariants

- UNREADABLE_IS_UNKNOWN — unreadable, unconfigured, timed-out, stale, or prepaid-with-unmeasured-burn is UNKNOWN, never GREEN. Wallets are INFO.
- READERS_NEVER_THROW — readers return UNKNOWN rows; `takeSnapshot` additionally converts throws and timeouts and never rejects.
- EVIDENCE_IS_EXPLICIT — sourceObservedAt differs from read-at observedAt; absent/stale freshness cannot grade GREEN/YELLOW. Native rates/transfer aggregates retain exact decimal strings and denomination; no FX or custody aggregation.
- SPEND_POLICY_IS_EXPLICIT — gradeSpend without caller thresholds is UNKNOWN.
- REPORTING_ONLY_UI — consuming finance tables do not render money-moving controls in this wave.
- ONE_ROW_MODEL — a Pay button is a `payAction` value, never a new row shape.
- `detail` never carries a URL, key, or address.
- OpenRouter burn is not measured here: `openRouterReader` exposes `usageTotal` and grades only from a caller-supplied `burnPerDay`. Current finance UIs do not compose this account reader: inherited provider credentials do not establish node account ownership or read-only privileges. Provider least privilege is separate task.5361.

## Not here

The alert decision, routes, DI wiring, env loading and UI stay in each consuming node ([keep-node-product-local](https://cognidao.org/knowledge/keep-node-product-local)). Operator-only planes (Akash, Cherry, Grafana, domain) are operator readers.

## Release

Bump `version`, merge, then push tag `money-plane-v<version>` at the merged main SHA; `.github/workflows/publish-packages.yml` publishes the Release asset.
