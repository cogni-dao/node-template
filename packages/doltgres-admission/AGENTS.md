# doltgres-admission · AGENTS.md

Small shared engine primitives for published knowledge/work-item adapters. No domain policy, runtime configuration, pool creation or environment loading. Queries execute exclusively through the injected reserved, bounded connection; ordinary pooled reads never enter this package.

The common writer lock is derived from the native base database. Doltgres 0.57.3 advisory names are process-wide. Bridge mode holds legacy work-item key 5001001, legacy knowledge key 5001002 and the common database key in that fixed order for the whole logical mutation. Database mode holds only the common database key; callers may select it only after proving that database has no legacy runtime. Both participants must share this protocol. Release reverses acquisition. An uncertain acquisition/release requires the caller to destroy its owned session before returning any pool slot.

Adapters retain admission queues, query budgets, logging and pool recovery. Branch mutation code preserves interrupted evidence and never automatically replays callbacks after an uncertain acknowledgement. Keep installed tarballs free of private workspace imports in runtime code AND declarations.
