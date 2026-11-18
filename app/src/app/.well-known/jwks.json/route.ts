// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Public proof-signing keys only; host secret configuration owns the private key. */
import { NextResponse } from "next/server";
import { serviceSigner } from "@/bootstrap/service-links";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try {
    return NextResponse.json((await serviceSigner()).jwks, {
      headers: { "cache-control": "public, max-age=60" },
    });
  } catch {
    return NextResponse.json(
      { error: "jwks_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
