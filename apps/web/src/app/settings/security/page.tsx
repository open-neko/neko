import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getOrgId, orgHasFeature, FEATURE } from "@/lib/db";
import { getInstallPolicyPayload } from "@/lib/install-policy-settings";
import SecurityForm from "./SecurityForm";

export default async function SettingsSecurityPage() {
  await connection();
  const orgId = await getOrgId();
  if (!(await orgHasFeature(orgId, FEATURE.installPolicy))) {
    redirect("/settings");
  }
  const payload = await getInstallPolicyPayload(orgId);
  return <SecurityForm initial={payload} />;
}
