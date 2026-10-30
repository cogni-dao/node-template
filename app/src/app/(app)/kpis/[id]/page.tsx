// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { redirect } from "next/navigation";
import { getServerSessionUser } from "@/lib/auth/server";
import { KpisView } from "../view";
export default async function KpiPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ observation?: string }>;
}) {
	if (!(await getServerSessionUser())) redirect("/");
	const { id } = await params;
	return (
		<KpisView metricId={id} observationId={(await searchParams).observation} />
	);
}
