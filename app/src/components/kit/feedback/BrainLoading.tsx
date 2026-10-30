// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@components/kit/feedback/BrainLoading`
 * Purpose: One wordless loading indicator for route streaming and chat readiness.
 * Scope: Presentational, server-renderable feedback; no hooks or animation runtime.
 * Invariants: Fills available space; image dimensions are reserved; reduced motion is respected.
 * Side-effects: none
 * @public
 */

import Image from "next/image";

import { brainLoading, brainLoadingMark } from "@/styles/ui";

export function BrainLoading() {
  return (
    <div role="status" aria-label="Loading" className={brainLoading()}>
      <Image
        src="/brain-loading.webp"
        alt=""
        width={64}
        height={64}
        unoptimized
        loading="eager"
        className={brainLoadingMark()}
      />
    </div>
  );
}
