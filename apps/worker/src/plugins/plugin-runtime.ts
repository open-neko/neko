import { RpcResponse } from "@open-neko/plugin-types";

/**
 * Runtime-agnostic plugin-runtime contract (SEC9). OpenShell is the
 * production runtime; SubprocessRuntime exists for plugin-author dev
 * mode. The former microsandbox runtime is gone — these abstractions
 * are what every runtime implements.
 */

/** Network policy translation for a plugin manifest's declared hosts. */
export type PluginNetworkMode = "none" | "public";

export interface PluginVmSpec {
  /** Unique handle for this VM, derived from the plugin npm name. */
  id: string;
  /** Path on host that the runtime mounts at /workspace in the VM. */
  hostWorkspacePath: string;
  /** Network policy derived from the plugin manifest's `requires_network`. */
  network: PluginNetworkMode;
  /**
   * Raw declared hosts from the manifest. OpenShellRuntime uses them
   * for per-host egress.
   */
  hosts?: readonly string[];
  /**
   * Secrets the plugin sends to its external API (manifest `inject: "egress"`).
   * Held gateway-side as an OpenShell provider; the box receives only a
   * placeholder aliased to `key`, and the egress proxy substitutes the real
   * value on outbound requests. The value never enters the sandbox.
   */
  egressSecrets?: ReadonlyArray<{ key: string; value: string }>;
}

export interface PluginRuntime {
  start(spec: PluginVmSpec): Promise<void>;
  /**
   * Invokes the plugin's runner with `node /workspace/run.js <method>
   * <paramsJson>` and parses the single JSON response from stdout.
   * If `env` is provided, the runtime makes those values available to the
   * plugin process WITHOUT placing secret values on the exec command line
   * (OpenShell sources an uploaded env file; the dev subprocess sets process env).
   */
  callRpc(
    pluginId: string,
    method: string,
    paramsJson: string,
    options?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<RpcResponse>;
  stop(pluginId: string): Promise<void>;
  destroyAll(): Promise<void>;
  hasPlugin(pluginId: string): boolean;
}

/**
 * Translates a manifest's declared network capability into the VM-level
 * network mode the runtime will enforce. Today: empty list → none,
 * any host → public. OpenShell additionally applies per-host egress
 * from `hosts`.
 */
export function networkModeFor(declaredHosts: readonly string[]): PluginNetworkMode {
  return declaredHosts.length === 0 ? "none" : "public";
}

/**
 * POSIX shell single-quote escape: wrap the value in single quotes and
 * replace any embedded single quote with `'\''`. Safe for all bytes.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ENV_KEY_RX = /^[A-Z][A-Z0-9_]*$/;

/**
 * Build a POSIX-shell-sourceable env file holding a plugin's secrets
 * (`export KEY='value'` lines). The runtime uploads this into the sandbox
 * out-of-band and the exec sources it — so secret VALUES never land in the
 * exec command line (which the OpenShell gateway logs) nor in the box's
 * process args. Keys are validated to UPPER_SNAKE_CASE so a bad manifest
 * entry can't smuggle shell syntax; values are POSIX single-quote-escaped.
 */
export function buildEnvFile(env: Record<string, string>): string {
  return Object.keys(env)
    .map((k) => {
      if (!ENV_KEY_RX.test(k)) {
        throw new Error(`plugin env key "${k}" is not a valid UPPER_SNAKE_CASE name`);
      }
      return `export ${k}=${shellQuote(env[k] ?? "")}`;
    })
    .join("\n");
}

const SHELL_VARNAME_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns the command + argv the runtime will invoke inside the VM.
 * With neither aliases nor an env file: a plain `node` exec, fastest path.
 * Otherwise wrap in `sh -c`: first re-export each provider-injected placeholder
 * to the env var the plugin reads (`export KEY="$from"` — a value reference, not
 * a value), then source the box-secret env file, then exec. The command carries
 * only var names + the file PATH, never a secret value.
 *
 * Why `sh` not `bash`: the default plugin VM image ships `ash` at `/bin/sh`
 * and no `bash`. POSIX `sh` is enough (export + source + exec + quoted args).
 */
export function buildExecCommand(
  method: string,
  paramsJson: string,
  opts: {
    envFilePath?: string;
    runnerPath?: string;
    aliases?: ReadonlyArray<{ from: string; to: string }>;
  } = {},
): { cmd: string; args: string[] } {
  const runnerPath = opts.runnerPath ?? "/workspace/run.js";
  const aliases = opts.aliases ?? [];
  if (!opts.envFilePath && aliases.length === 0) {
    return { cmd: "node", args: [runnerPath, method, paramsJson] };
  }
  const aliasExports = aliases.map(({ from, to }) => {
    if (!SHELL_VARNAME_RX.test(from) || !SHELL_VARNAME_RX.test(to)) {
      throw new Error(`plugin env alias "${from}"->"${to}" is not a valid shell var name`);
    }
    return `export ${to}="$${from}"`;
  });
  const inner = [
    ...aliasExports,
    ...(opts.envFilePath ? [`. ${shellQuote(opts.envFilePath)}`] : []),
    `exec node ${runnerPath} ${shellQuote(method)} ${shellQuote(paramsJson)}`,
  ].join("; ");
  return { cmd: "sh", args: ["-c", inner] };
}
