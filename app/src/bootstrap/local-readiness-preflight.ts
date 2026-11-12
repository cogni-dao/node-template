// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  assertEvmRpcConfig,
  assertRuntimeSecrets,
} from "@/shared/env/invariants";
/** Synchronous local admission assertions; never constructs a container or contacts dependencies. */
import { serverEnv } from "@/shared/env/server-env";

export function localReadinessPreflight(): ReturnType<typeof serverEnv> {
  const env = serverEnv();
  assertRuntimeSecrets(env);
  assertEvmRpcConfig(env);
  return env;
}
