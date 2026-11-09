// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/CopyLinkButton`
 * Purpose: Icon-only affordance that copies a knowledge block's absolute permalink; stops propagation so it lives inside clickable rows.
 * Scope: Pure presentation + clipboard write. Thin adapter: the implementation is published by `@cogni/knowledge-base-ui` (task.0059).
 * @internal
 */

"use client";

export { CopyLinkButton } from "@cogni/knowledge-base-ui";
