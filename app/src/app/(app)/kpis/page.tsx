// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { redirect } from "next/navigation";
import { getServerSessionUser } from "@/lib/auth/server";
import { KpisView } from "./view";
export default async function KpisPage() {
	if (!(await getServerSessionUser())) redirect("/");
	return <KpisView />;
}
