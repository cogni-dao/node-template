// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Thin ai mount; shared service-link lifecycle owns every transition. */
import { serviceLinkRoute } from "@/app/_lib/service-links";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = serviceLinkRoute("ai", "read");
export const DELETE = serviceLinkRoute("ai", "disconnect");
