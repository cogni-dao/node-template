// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkItemDetailBody`
 * Purpose: Helps a human decide what the item is, whether its latest review lets it move, and why it moved.
 * Scope: Binding only (story.0085, ONE_VIEW): the whole view is `WorkItemView` from `@cogni/knowledge-base-ui/work-item`.
 * Side-effects: none (the view reads older pages through the client). Links: hub work-item-view-capability
 * @internal
 */

"use client";

import type { CitationLinkComponent } from "@cogni/knowledge-base-ui";
import { WorkItemView } from "@cogni/knowledge-base-ui/work-item";
import type { WorkItemDto, WorkItemsGetOutput } from "@cogni/node-contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactElement } from "react";

import { Markdown } from "@/components/markdown";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/sheet";

import { PeekLink } from "../../_components/EntityPeek";
import { workItemClient as client } from "../_api/fetchWorkItems";
import { workItemHref } from "../_lib/workItemNavigation";

/** The view's in-page link: stays on the page, keeps scroll, never peeks (an artifact is not a knowledge entry). */
const ScrollKeepingLink: CitationLinkComponent = ({ entityId: _entityId, href, ...props }) => (
	<Link href={href} scroll={false} {...props} />
);

export interface WorkItemDetailBodyProps {
	readonly item: WorkItemsGetOutput | WorkItemDto | null;
	readonly itemId?: string;
	readonly isLoading?: boolean;
	readonly error?: Error | null;
}

export function WorkItemDetailBody({ item, itemId, isLoading = false, error = null }: WorkItemDetailBodyProps): ReactElement {
	// Outside the app router (a host that renders the body alone) there are no parameters.
	const searchParams = useSearchParams() ?? undefined;
	return (
		<WorkItemView
			item={item}
			itemId={itemId}
			isLoading={isLoading}
			error={error}
			client={client}
			{...(searchParams && { searchParams })}
			itemHref={workItemHref}
			Link={ScrollKeepingLink}
			PeekLink={PeekLink}
			Markdown={Markdown}
			Header={SheetHeader}
			Title={SheetTitle}
			Description={SheetDescription}
		/>
	);
}
