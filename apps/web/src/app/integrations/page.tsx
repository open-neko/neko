import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/actor";
import {
  getDeploymentConnectStatus,
  getOperatorConnectStatus,
  listConnectProviders,
} from "@/lib/integrations";
import IntegrationsList from "./IntegrationsList";

export default async function IntegrationsPage() {
  await connection();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") {
    redirect("/signin?returnTo=/integrations");
  }
  const [providers, status, deploymentStatus] = await Promise.all([
    listConnectProviders(),
    actor.userId ? getOperatorConnectStatus(actor.userId) : Promise.resolve([]),
    getDeploymentConnectStatus(),
  ]);
  const connectedByPlugin = new Map(status.map((s) => [s.pluginName, s]));
  const deploymentConnectedByPlugin = new Map(
    deploymentStatus.map((s) => [s.pluginName, s]),
  );
  const rowFor = (
    p: (typeof providers)[number],
    map: Map<string, { connectedAt: string; scopes?: string[] }>,
  ) => ({
    pluginId: p.pluginId,
    pluginName: p.pluginName,
    providerLabel: p.providerLabel,
    scopes: p.scopes,
    flow: p.flow,
    credentialScope: p.credentialScope,
    connected: map.has(p.pluginName),
    connectedAt: map.get(p.pluginName)?.connectedAt ?? null,
  });
  const workspace = providers
    .filter((p) => p.credentialScope === "deployment")
    .map((p) => rowFor(p, deploymentConnectedByPlugin));
  const connectors = providers
    .filter((p) => p.credentialScope !== "deployment")
    .map((p) => rowFor(p, connectedByPlugin));
  return <IntegrationsList initial={{ workspace, connectors }} />;
}
