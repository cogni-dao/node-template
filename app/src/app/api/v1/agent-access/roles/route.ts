// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** human role mount. Shared handler/authority preserves own credentials and no self approval. */
import { createRoleRoutes } from "@/app/_lib/agent-access/roles-route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handlers = createRoleRoutes("human");
export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
