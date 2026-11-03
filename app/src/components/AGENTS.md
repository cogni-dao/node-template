# components · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Last reviewed:** 2026-11-03
- **Status:** draft

## Purpose

Shared presentational UI. No business logic, no data fetching. Design tokens and variants only.

## Pointers

- [Architecture](../../../../docs/spec/architecture.md)
- [Frontend design guide](https://node-template.cognidao.org/knowledge/frontend-design-guide)

## Boundaries

```json
{
  "layer": "components",
  "may_import": ["components", "shared", "types", "styles"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters/server",
    "adapters/worker",
    "contracts",
    "bootstrap"
  ]
}
```

## Public Surface

- **Exports:** UI components and widgets via `components/index.ts`
- **Files considered API:** `index.ts`, `kit/*/index.tsx`

## Responsibilities

- This directory **does**: Presentational UI, tokens, themes, CVA variants, local UI state only.
- This directory **does not**: Domain rules, DB/IO, network calls, adapter logic.

## Usage

**IMPORTANT: Before changing files in this directory, load the `frontend-design` skill (it reads `GET /api/v1/knowledge/frontend-design-guide`).** Human view: [frontend design guide](https://node-template.cognidao.org/knowledge/frontend-design-guide)

Minimal local commands:

```bash
pnpm typecheck
pnpm lint
```

## Standards

```
src/components/
  vendor/                # owned third-party source (assistant-ui, shadcn-io). Wrap in kit/; never import from features.
  kit/                   # domain-neutral wrappers. className for layout only.
    layout/              # Container, PageContainer, Card, SectionCard, skeletons
    inputs/              # Button, Input, ModeToggle, SplitInput, TimeRangeSelector
    data-display/        # Badge, Avatar, ScrollArea, RunCard, ActivityTable/Chart, PhaseList
    navigation/          # NavigationLink, MobileNav
    feedback/            # Alert, ErrorAlert, Progress, BrainLoading, HintText
    overlays/            # Dialog
    payments/            # UsdcPaymentFlow, PaymentButton, PaymentStatusChip
    auth/                # WalletConnectButton, SignInDialog
    chat/                # Thread, composer inputs
    animation/           # Reveal
    sections/            # Hero, CtaSection, FeaturesGrid
  index.ts               # curated barrel: kit + @cogni/node-ui-kit primitives
```

- Placement, styling, mobile-first, and performance rules live in the [frontend design guide](https://node-template.cognidao.org/knowledge/frontend-design-guide). Read it before editing; do not copy its rules here.
- Shared shadcn/Radix/reui primitives come from `@cogni/node-ui-kit` (baseline, read-only for forks) and are re-exported through `index.ts`.
- **Testing:** Snapshot widgets and critical primitives. No network. Client-only tests isolate interactivity.

## Dependencies

- **Internal:** shared/util, styles/
- **External:** React, Radix UI primitives, class-variance-authority

## Change Protocol

- Update **Last reviewed** and this file when exports or subdir rules change.
- Run boundary lint. Refuse merges that import outside `may_import`.

## Notes

- Each file: short header with Purpose, Scope, Invariants. No inline commentary drift.
- Implementation workflows live in the [frontend design guide](https://node-template.cognidao.org/knowledge/frontend-design-guide).
