// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/startup`
 * Purpose: Narrow public entry for the authenticated shell's first paint.
 * Invariants: STARTUP_OFF_BARREL — shell code imports only this entry, never the component barrel or vendor paths.
 * Side-effects: none
 * @public
 */

export {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	SidebarProvider,
	SidebarRail,
	SidebarSeparator,
	SidebarTrigger,
} from "@cogni/node-ui-kit/shadcn/sidebar";
/** Public shell entry. Sidebar exports share the same context as the main barrel. */
export { Button } from "./kit/inputs/Button";
export { Input } from "./kit/inputs/Input";
