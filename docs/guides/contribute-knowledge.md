---
id: guide.contribute-knowledge
type: guide
title: Contribute Node Knowledge
status: draft
trust: draft
summary: How to decide whether a reusable finding belongs in node knowledge instead of a PR note.
read_when: An implementation produced durable context future node contributors should recall.
owner: derekg1729
created: 2026-06-05
verified: null
tags: [knowledge, agents, nodes]
---

# Contribute Node Knowledge

Most findings do not deserve durable storage. Keep routine implementation state in the PR. Write knowledge only when it will help future contributors make a better decision.

## Decision Order

1. Stay silent for routine state, obvious facts, ephemeral debugging, or anything visible from code.
2. Recall existing node knowledge before writing a new entry.
3. Refine an existing entry when it is close but stale, vague, or bloated.
4. Add a citation when the new fact supports or contradicts an existing entry. Cite across planes freely: an entry on your open contribution branch may cite one already merged to `main` â this resolves correctly and the edge goes live in `main`'s DAG when your contribution merges. (Before bug.5024 this silently 500'd; it now works, so don't avoid citing merged atoms from a long-lived branch.)
5. Write a new atomic entry only when no existing entry fits â and nearly always cite at least one existing entry in the same edit (`supports`/`extends`/`contradicts`/`supersedes`). A new atom should compound onto the graph, not land as an island; recall almost always surfaces a parent or sibling to link.

## What Belongs

- A durable architectural invariant.
- A repeated failure mode and its reliable fix.
- A reusable validation recipe.
- A node-domain rule future agents should follow.

## What Does Not Belong

- PR status.
- A command transcript.
- A one-off bug trace.
- A note that code, tests, or `AGENTS.md` already make obvious.
- A new atom with zero citation edges â the island failure. A new entry should nearly always cite a parent/sibling recall surfaced (cross-plane to merged atoms works); islands don't compound and leave the hub a flat document store.
- Secret values or private user data.

## Shape

Prefer one compact markdown atom:

```markdown
## Claim

One falsifiable statement.

## Evidence

Where this was observed.

## Use

When a future agent should recall it.
```

If the node is connected to the Cogni operator knowledge API, contribute through that API so knowledge is recallable by future agents. If not, keep the note in the smallest node-owned docs location and link it from `AGENTS.md` only when it is operationally important.
