// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { agentNameKey, hasHiddenCharacters } from "../src";

describe("agent name key (same name to a person = same key)", () => {
  it("ignores case, spacing and compatibility look-alikes", () => {
    const key = agentNameKey("General assistant");
    expect(agentNameKey("  general   ASSISTANT ")).toBe(key);
    expect(agentNameKey("General\tassistant")).toBe(key);
    expect(agentNameKey("Ｇeneral assistant")).toBe(key); // fullwidth G
    expect(agentNameKey("Priority scorer")).not.toBe(key);
  });
  it("sees through hidden and direction characters", () => {
    expect(agentNameKey("General​ assistant")).toBe("general assistant");
    expect(agentNameKey("‮General assistant")).toBe("general assistant");
  });
  it("refuses a name that carries hidden or direction characters", () => {
    for (const bad of ["Gen​eral", "‮evil", "a\u0000b", "line break", "iso⁦late"]) expect(hasHiddenCharacters(bad), JSON.stringify(bad)).toBe(true);
    for (const ok of ["Helper bot", "Review agent 2", "Zoë's agent"]) expect(hasHiddenCharacters(ok), ok).toBe(false);
  });
});
