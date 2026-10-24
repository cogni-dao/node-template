# scheduling · AGENTS.md

> Scope: this directory only.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Read-only orchestration for caller-owned schedule configuration, run history and saved assistant responses.

## Boundaries

Features depend on injected ports and shared contracts. No bootstrap, adapter, or app imports.

## Public Surface

- `createScheduleHistoryService` — schedule, history and output reads
- `ScheduleHistoryNotFoundError` — missing or foreign schedule/run

## Invariants

- Schedule ownership is required independently of run requester identity.
- Output uses the caller-owned nondeleted thread and exact assistant run ID.
- Metadata never loads threads; chosen output returns complete saved text only.
- Runtime status is not task success. No execution or persistence side effects.
