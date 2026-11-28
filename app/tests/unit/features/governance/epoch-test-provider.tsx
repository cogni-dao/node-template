// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { EpochsProvider, type EpochsClient } from "@cogni/knowledge-base-ui/epochs";
import { createElement, type ReactNode } from "react";

/** Node-owned transport fixture for tests of the shared public hooks. */
export function epochTestProvider(children: ReactNode, signTypedData?: EpochsClient["signTypedData"]) {
  const endpoint = (id: string, suffix: string) => `/api/v1/attribution/epochs/${id}/${suffix}`;
  const client: EpochsClient = {
    request: (url, init) => fetch(url, init),
    signTypedData,
    wallet: {} as EpochsClient["wallet"],
    endpoints: {
      epochs: "/api/v1/attribution/epochs",
      lifecycle: "/api/v1/attribution/settlement-lifecycle",
      collect: "/api/v1/attribution/epochs/collect",
      projections: (id) => endpoint(id, "user-projections"),
      claimants: (id) => endpoint(id, "claimants"),
      activity: (id) => endpoint(id, "activity"),
      overrides: (id) => endpoint(id, "review-subject-overrides"),
      review: (id) => endpoint(id, "review"),
      signData: (id) => endpoint(id, "sign-data"),
      finalize: (id) => endpoint(id, "finalize"),
      distribution: (id) => endpoint(id, "distribution-tx"),
    },
  };
  return createElement(EpochsProvider, { client }, children);
}
