import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AdminDenied } from "@/app/admin/AdminShell";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId, orgHasFeature, FEATURE } from "@/lib/db";
import { getInstallPolicyPayload } from "@/lib/install-policy-settings";
import SecurityForm from "./SecurityForm";

export default async function SettingsSecurityPage() {
  await connection();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") return <AdminDenied />;

  const orgId = await getOrgId();
  if (!(await orgHasFeature(orgId, FEATURE.installPolicy))) {
    redirect("/admin/settings");
  }
  const payload = await getInstallPolicyPayload(orgId);
  return <SecurityForm initial={payload} />;
}
