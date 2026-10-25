# scheduling · AGENTS.md

> Scope: this directory only.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Read-only orchestration for caller-owned schedule configuration, run history and existing thread correlation.

## Boundaries

Features depend on injected ports and shared contracts. No bootstrap, adapter, or app imports.

## Public Surface

- `createScheduleHistoryService` — schedule and history reads
- `ScheduleHistoryNotFoundError` — missing or foreign schedule

## Invariants

- Schedule ownership is required independently of run requester identity.
- Metadata projects nullable stateKey without loading any thread content.
- Existing chat routes authorize and display linked conversations.
- Runtime status is not task success. No execution or persistence side effects.
