// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/governing-index`
 * Purpose: Prove uncapped content-free local governing discovery and adapter parity.
 * Scope: In-memory adapter tests; real Doltgres parity is in the component CI lane.
 * Invariants: One governing selector; no blank trigger or superseded target routes.
 * Side-effects: none
 * Links: task.5309; src/domain/governing.ts
 * @internal
 */
import { afterEach, expect, it, vi } from "vitest";
import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";

afterEach(() => vi.useRealTimers());

it("returns an old rule beyond fifty same-domain rows and excludes evidence, blank triggers and superseded rows", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "method", name: "Method" });
  await store.withWrite(
    { operationId: "governing-fixture", message: "fixture" },
    async (write) => {
      const add = (id: string, entryType: string, useWhen: string | null) =>
        write.addKnowledge({
          id,
          domain: "method",
          title: "title",
          content: "PRIVATE BODY",
          entryType,
          useWhen,
          sourceType: "human",
        });
      await add("old-rule", "rule", "  review infrastructure  ");
      vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
      for (let i = 0; i < 55; i++)
        await add(`evidence-${i}`, "finding", "evidence");
      await add("blank-guide", "guide", "   ");
      await add("retired-guide", "guide", "old guidance");
      await add("new-reference", "reference", "new guidance");
      await write.addCitation({
        citingId: "new-reference",
        citedId: "retired-guide",
        citationType: "supersedes",
      });
    }
  );
  const before = store.commitLog.length;
  expect(
    (await store.listKnowledge("method", { limit: 50 })).some(
      (r) => r.id === "old-rule"
    )
  ).toBe(false);
  expect(await store.listGoverningIndex()).toEqual([
    {
      id: "new-reference",
      domain: "method",
      entryType: "reference",
      useWhen: "new guidance",
    },
    {
      id: "old-rule",
      domain: "method",
      entryType: "rule",
      useWhen: "review infrastructure",
    },
  ]);
  expect(store.commitLog).toHaveLength(before);
  expect(JSON.stringify(await store.listGoverningIndex())).not.toContain(
    "PRIVATE BODY"
  );
});

it.each([
  "skill",
  "guide",
  "playbook",
  "rule",
  "design",
  "decision",
  "reference",
])("routes the canonical governing type %s by trigger", async (entryType) => {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "method", name: "Method" });
  await store.withWrite(
    { operationId: `fixture:${entryType}`, message: "fixture" },
    (write) =>
      write.addKnowledge({
        id: "qualified",
        domain: "method",
        title: "not routing text",
        content: "PRIVATE BODY",
        entryType,
        useWhen: "a precise situation",
        sourceType: "human",
      })
  );
  expect(await store.listGoverningIndex()).toEqual([
    {
      id: "qualified",
      domain: "method",
      entryType,
      useWhen: "a precise situation",
    },
  ]);
});
