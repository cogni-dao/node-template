// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/identity-client`
 * Purpose: Read a node-owned sign-in start response.
 * Scope: Response validation only; callers own requests and navigation.
 * Invariants: Errors do not expose response data or underlying exceptions.
 * Side-effects: Invokes the caller's request once.
 * Links: package.json
 * @public
 */

/** Read an absolute HTTP(S) authorize URL without changing its original text. */
export async function requestAuthorizeUrl(
  request: () => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>,
): Promise<string> {
  try {
    const response = await request();
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (body === null || typeof body !== "object") throw new Error();
    const url = (body as { authorizeUrl?: unknown }).authorizeUrl;
    if (typeof url !== "string" || !url.trim()) throw new Error();
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error();
    return url;
  } catch {
    throw new Error("Unable to start sign-in.");
  }
}
