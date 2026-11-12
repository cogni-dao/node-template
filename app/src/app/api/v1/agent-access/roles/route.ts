// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** human role mount. Shared handler/authority preserves own credentials and no self approval. */
import { createRoleRoutes } from "@/app/_lib/agent-access/roles-route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const { GET, POST, DELETE } = createRoleRoutes("human");
