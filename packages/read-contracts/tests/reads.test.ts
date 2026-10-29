import { describe, expect, it } from "vitest";
import { SubjectRefSchema, WorkItemDtoSchema } from "../src/work-items.js";
import { KnowledgeRowSchema } from "../src/knowledge.js";

describe("public read semantics", () => {
  it("requires actual revisions and discriminated identifiers", () => {
    for (const ref of [{ kind: "user", userId: "u" }, { kind: "agent", agentId: "a" }, { kind: "system", serviceId: "s" }]) {
      expect(SubjectRefSchema.parse(ref)).toEqual(ref);
    }
    expect(SubjectRefSchema.safeParse({ kind: "agent", id: "a" }).success).toBe(false);
    expect(WorkItemDtoSchema.shape.revision.safeParse(undefined).success).toBe(false);
  });
  it("retains nullable timestamps and optional nullable triggers", () => {
    expect(KnowledgeRowSchema.shape.createdAt.parse(null)).toBeNull();
    expect(KnowledgeRowSchema.shape.useWhen.parse(undefined)).toBeUndefined();
    expect(KnowledgeRowSchema.shape.useWhen.parse(null)).toBeNull();
  });
});
