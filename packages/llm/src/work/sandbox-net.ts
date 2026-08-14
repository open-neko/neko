import { lookup } from "node:dns/promises";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** Host networking as seen from an OpenShell sandbox when no shared Docker
 * network is configured. Loopback on the host is unreachable from a box, so
 * the gateway exposes the host as `host.openshell.internal` instead. */
export const SANDBOX_HOST_ALIAS = "host.openshell.internal";

const LOOPBACK_HOST =
  /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1?\]?)$/iu;

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOST.test(hostname);
}

/**
 * A name a sandbox cannot reach without additional networking: host loopback,
 * or a dot-less Docker Compose service name (`graphjin`, `neko-db`).
 */
export function isHostLocalName(hostname: string): boolean {
  return isLoopbackHost(hostname) || !hostname.includes(".");
}

/** Rewrite a host-local URL to its sandbox-reachable host alias. */
export function sandboxReachableUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!isHostLocalName(u.hostname)) return raw;
    u.hostname = SANDBOX_HOST_ALIAS;
    return u.toString();
  } catch {
    return raw;
  }
}

type HostLookup = (hostname: string) => Promise<string>;

const lookupIPv4: HostLookup = async (hostname) =>
  (await lookup(hostname, { family: 4 })).address;

/**
 * Resolve a URL before it enters an OpenShell sandbox policy. The Docker
 * sandbox joins the Compose network, but OpenShell runs workloads in an inner
 * network namespace whose resolver cannot use Docker's service-name DNS.
 * Resolve the name in web/worker and give the policy the current private IP;
 * no host port is needed.
 */
export async function resolveSandboxReachableUrl(
  raw: string,
  sharedComposeNetwork = process.env.OPENNEKO_SANDBOX_SHARED_NETWORK === "1",
  resolveHost: HostLookup = lookupIPv4,
): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (
    sharedComposeNetwork &&
    isHostLocalName(u.hostname) &&
    !isLoopbackHost(u.hostname)
  ) {
    u.hostname = await resolveHost(u.hostname);
    return u.toString();
  }
  return sandboxReachableUrl(raw);
}

type NetworkMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Private address advertised to sandboxes for the in-process broker. */
export function sandboxBrokerHost(
  explicit = process.env.OPENNEKO_BROKER_HOST_ALIAS,
  sharedComposeNetwork = process.env.OPENNEKO_SANDBOX_SHARED_NETWORK === "1",
  networks: NetworkMap = networkInterfaces(),
): string | undefined {
  if (explicit) return explicit;
  if (!sharedComposeNetwork) return undefined;

  for (const addresses of Object.values(networks)) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === "IPv4") return address.address;
    }
  }
  throw new Error(
    "no IPv4 address is available for the Docker-only sandbox broker",
  );
}
