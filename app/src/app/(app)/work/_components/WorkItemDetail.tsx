// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import { Sheet, SheetContent } from "@/components/sheet";
import type { WorkItemDetailBodyProps } from "./WorkItemDetailBody";
import { WorkItemDetailBody } from "./WorkItemDetailBody";

/** Existing eager detail API, used by dashboard. */
export function WorkItemDetail({
	open,
	onOpenChange,
	...body
}: WorkItemDetailBodyProps & {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-lg">
				<WorkItemDetailBody {...body} />
			</SheetContent>
		</Sheet>
	);
}
