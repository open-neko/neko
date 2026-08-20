import { connection } from "next/server";
import { AdminDenied } from "@/app/admin/AdminShell";
import { getCurrentActor } from "@/lib/actor";
import MagentoPackAdmin from "./MagentoPackAdmin";

export default async function SettingsPacksPage() {
  await connection();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") return <AdminDenied />;
  return <MagentoPackAdmin />;
}
