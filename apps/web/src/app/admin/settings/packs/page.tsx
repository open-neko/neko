import { connection } from "next/server";
import { AdminDenied } from "@/app/admin/AdminShell";
import { getCurrentActor } from "@/lib/actor";
import MagentoPackAdmin from "./MagentoPackAdmin";
import { MAGENTO_VISUAL_FIXTURE } from "./magento-visual-fixture";

export default async function SettingsPacksPage() {
  await connection();
  const visualTest =
    process.env.NODE_ENV !== "production" &&
    process.env.OPENNEKO_MAGENTO_VISUAL_TEST === "true";
  if (visualTest) return <MagentoPackAdmin fixture={MAGENTO_VISUAL_FIXTURE} />;
  const actor = await getCurrentActor();
  if (actor.role !== "admin") return <AdminDenied />;
  return <MagentoPackAdmin />;
}
