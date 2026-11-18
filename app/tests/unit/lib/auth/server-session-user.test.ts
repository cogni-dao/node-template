// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/lib/auth/server-session-user`
 * Purpose: `getServerSessionUser` marks the cookie-session identity `via: "session"`, so the route wrapper never runs the service-key gate on a human.
 * Scope: Unit; NextAuth is faked. `via` is set by this module from the NextAuth session only.
 * Side-effects: none
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("next-auth", () => ({ getServerSession: async () => fake.session }));
vi.mock("@/auth", () => ({ authOptions: {} }));

import { getServerSessionUser } from "@/lib/auth/server";

describe("getServerSessionUser", () => {
  beforeEach(() => {
    fake.session = null;
  });

  it("marks a cookie session identity via: session", async () => {
    fake.session = { user: { id: "u1", walletAddress: "0xabc", displayName: "A", avatarColor: "#fff" } };
    expect(await getServerSessionUser()).toEqual({
      id: "u1",
      walletAddress: "0xabc",
      displayName: "A",
      avatarColor: "#fff",
      via: "session",
    });
  });

  it("does not take `via` from the session payload: a session that claims bearer is still session", async () => {
    fake.session = { user: { id: "u1", via: "bearer" } };
    expect(await getServerSessionUser()).toMatchObject({ id: "u1", via: "session" });
  });

  it("returns null with no id", async () => {
    fake.session = { user: {} };
    expect(await getServerSessionUser()).toBeNull();
  });
});
