---
description: Route the bound node work item to its lifecycle command.
---

Continue the current node's owned work item: #$ITEM.
Invoke the command for its status, preserving all invocation arguments.

| status                      | invoke                 |
| --------------------------- | ---------------------- |
| needs_triage                | /triage                |
| needs_research              | /research              |
| needs_design                | /design                |
| needs_design_review         | /review-design         |
| needs_implement             | /implement             |
| needs_implementation_review | /review-implementation |
| needs_validation            | /validate-candidate    |
| needs_merge                 | /closeout (after the operator merge) |
| needs_closeout, blocked (legacy) | /triage (placed by the cutover job) |

An item moves forward one stage at a time, and only with the exit artifact of the
stage it leaves, recorded by someone other than the author; the store refuses
anything else as `gate_unmet` and names what is missing. It may move back to
needs_triage or an earlier stage with a reason. `blocked` is not a stage: record
the blocker in `blockedBy`, and move back if it invalidates the stage.

Each command loads its owning procedure and any required dependencies.
A multi-task outcome uses dev-manager. Knowledge-only contributions use
contribute-knowledge-to-cogni.
