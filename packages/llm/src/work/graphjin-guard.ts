import { writeFile, readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Path to the stdin->stdout compactor the wrapper pipes GraphJin output
// through. Resolved lazily (NOT at module load): importing @neko/llm/work in a
// bundler — e.g. the Next.js build collecting page data — would otherwise
// evaluate import.meta.url + fileURLToPath at eval time, which throws there.
function compactCliSource(): string {
  return fileURLToPath(new URL("./tool-output/compact-cli.mjs", import.meta.url));
}

/**
 * GraphJin write-path subcommands. Even when the agent goes through
 * `graphjin cli`, these mutate server state and must be blocked.
 *
 * Mirrors Reckon's `inspectBashForGraphjinMutations` denylist.
 */
export const GRAPHJIN_WRITE_SUBCOMMANDS = [
  "setup",
  "config",
  "write_query",
  "write_mutation",
  "save_workflow",
  "update_current_config",
  "apply_schema_changes",
  "reload_schema",
  "apply_database_setup",
  "preview_schema_changes",
] as const;

const WRITE_SUBCOMMANDS = GRAPHJIN_WRITE_SUBCOMMANDS;

/** GJ5: grants must name known write subcommands — anything else is ignored. */
function sanitizeGrants(allow: string[] | undefined): string[] {
  if (!allow || allow.length === 0) return [];
  return allow.filter((s) =>
    (WRITE_SUBCOMMANDS as readonly string[]).includes(s),
  );
}

const EXECUTOR_SUBCOMMANDS = [
  "execute_graphql",
  "execute_saved_query",
  "execute_workflow",
] as const;

const RAW_HTTP_TOOLS = ["curl", "wget"] as const;

/**
 * Allowlist gate: the agent's contract is `graphjin cli <subcommand>` only.
 * Anything else (`serve`, `migrate`, `admin`, bare invocation, etc.) is
 * denied. Within `cli`, write subcommands and mutation/subscription ops
 * are denied; everything else passes. GJ5: a per-run policy may grant
 * specific write subcommands (admin actors only, resolved upstream) —
 * mutations/subscriptions in executor payloads stay blocked regardless.
 */
export function isGraphjinCommandSafe(
  args: string[],
  opts: { allowSubcommands?: string[] } = {},
): boolean {
  if (args.length === 0) return false;
  if (args[0] !== "cli") return false;

  const granted = sanitizeGrants(opts.allowSubcommands);
  const sub = args[1];
  if (!sub) return false;
  if (
    (WRITE_SUBCOMMANDS as readonly string[]).includes(sub) &&
    !granted.includes(sub)
  ) {
    return false;
  }

  if ((EXECUTOR_SUBCOMMANDS as readonly string[]).includes(sub)) {
    const joined = args.slice(2).join(" ");
    if (/\b(mutation|subscription)\b/i.test(joined)) return false;
  }
  return true;
}

export async function ensureGraphjinGuard(
  binRoot: string,
  graphjinBinary: string,
  opts: {
    /** GJ4: pin the CLI at a per-run config home. client.json is written
     *  under OS-specific config dirs there and carries this run's actor
     *  token. Defaults to the process XDG so legacy runs are unchanged. */
    xdgConfigHome?: string;
    /** GJ5: write subcommands this run's policy grants (admin actors only). */
    allowSubcommands?: string[];
  } = {},
): Promise<string> {
  const wrapperPath = join(binRoot, "graphjin");
  const compactCliPath = join(binRoot, "compact-cli.mjs");
  const granted = sanitizeGrants(opts.allowSubcommands);
  const denied = WRITE_SUBCOMMANDS.filter((s) => !granted.includes(s));
  const writeAlt = denied.join("|");
  const execAlt = EXECUTOR_SUBCOMMANDS.join("|");
  const pinnedXdgConfigHome =
    opts.xdgConfigHome?.trim() || process.env.XDG_CONFIG_HOME?.trim() || "";
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    pinnedXdgConfigHome
      ? `export XDG_CONFIG_HOME=${shellQuote(pinnedXdgConfigHome)}`
      : "",
    pinnedXdgConfigHome
      ? `export HOME=${shellQuote(pinnedXdgConfigHome)}`
      : "",
    "",
    "if [[ \"${1:-}\" != \"cli\" ]]; then",
    "  echo \"OpenNeko allows only 'graphjin cli <subcommand>'. Direct '${1:-(none)}' invocations are not permitted.\" >&2",
    "  exit 2",
    "fi",
    "",
    "sub=\"${2:-}\"",
    ...(denied.length > 0
      ? [
          "case \"$sub\" in",
          `  ${writeAlt})`,
          "    echo \"OpenNeko blocks GraphJin write subcommands. Read/query only.\" >&2",
          "    exit 2",
          "    ;;",
          "esac",
          "",
        ]
      : []),
    "case \"$sub\" in",
    `  ${execAlt})`,
    "    rest=\"${*:3}\"",
    "    if [[ \"$rest\" =~ (^|[^[:alnum:]_])(mutation|subscription)([^[:alnum:]_]|$) ]]; then",
    "      echo \"OpenNeko blocks GraphJin mutations and subscriptions. Read/query only.\" >&2",
    "      exit 2",
    "    fi",
    "    ;;",
    "esac",
    "",
    "# Run GraphJin, then compact large JSON results to columnar tables before",
    "# the model sees them (OPENNEKO_GRAPHJIN_COMPACT=0 disables). Any failure",
    "# falls back to the raw output — never corrupts a tool result.",
    "status=0",
    `out=$("${graphjinBinary}" "$@") || status=$?`,
    `cli=${shellQuote(compactCliPath)}`,
    'if [[ "${OPENNEKO_GRAPHJIN_COMPACT:-1}" != "0" && "$status" -eq 0 && "${#out}" -gt 2048 ]]; then',
    '  if compacted=$(printf "%s" "$out" | node "$cli" 2>/dev/null); then',
    '    printf "%s" "$compacted"',
    "  else",
    '    printf "%s" "$out"',
    "  fi",
    "else",
    '  printf "%s" "$out"',
    "fi",
    'exit "$status"',
    "",
  ].join("\n");
  await writeFile(compactCliPath, await readFile(compactCliSource()), { mode: 0o755 });
  await writeFile(wrapperPath, script, { encoding: "utf8", mode: 0o755 });
  await ensureRawHttpToolGuards(binRoot);
  return wrapperPath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function ensureRawHttpToolGuards(binRoot: string): Promise<void> {
  await Promise.all(
    RAW_HTTP_TOOLS.map(async (tool) => {
      const realBinary = await resolveBinaryOnPath(tool, [binRoot]);
      const wrapperPath = join(binRoot, tool);
      await writeFile(wrapperPath, rawHttpToolGuardScript(tool, realBinary), {
        encoding: "utf8",
        mode: 0o755,
      });
    }),
  );
}

function rawHttpToolGuardScript(
  tool: (typeof RAW_HTTP_TOOLS)[number],
  realBinary: string | null,
): string {
  const timeoutExec =
    tool === "curl"
      ? 'exec "$real_binary" --max-time "$timeout_seconds" "$@"'
      : 'exec "$real_binary" "--timeout=$timeout_seconds" "$@"';
  const timeoutCases =
    tool === "curl"
      ? "--max-time|--max-time=*|-m|-m*)"
      : "--timeout|--timeout=*|-T|-T*)";

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "for arg in \"$@\"; do",
    "  case \"$arg\" in",
    "    */api/v1/mcp*|*/api/v1/graphql*)",
    "      echo \"OpenNeko blocks raw HTTP access to GraphJin from agent shell tools. Use 'graphjin cli execute_graphql' through the terminal tool.\" >&2",
    "      exit 2",
    "      ;;",
    "  esac",
    "done",
    "",
    realBinary
      ? `real_binary=${shellQuote(realBinary)}`
      : "real_binary=",
    "if [[ -z \"$real_binary\" || ! -x \"$real_binary\" ]]; then",
    `  echo "OpenNeko could not find a real ${tool} binary on PATH." >&2`,
    "  exit 127",
    "fi",
    "",
    "has_timeout=0",
    "for arg in \"$@\"; do",
    "  case \"$arg\" in",
    `    ${timeoutCases}`,
    "      has_timeout=1",
    "      ;;",
    "  esac",
    "done",
    "",
    "if [[ \"$has_timeout\" -eq 1 ]]; then",
    "  exec \"$real_binary\" \"$@\"",
    "fi",
    "",
    "timeout_seconds=${OPENNEKO_HTTP_TOOL_TIMEOUT_SECONDS:-20}",
    timeoutExec,
    "",
  ].join("\n");
}

export async function resolveBinaryOnPath(
  name: string,
  skipEntries: string[] = [],
): Promise<string | null> {
  const pathValue = process.env.PATH || "";
  const skip = new Set(skipEntries.filter(Boolean));
  for (const entry of pathValue.split(":")) {
    if (!entry) continue;
    if (skip.has(entry)) continue;
    const candidate = join(entry, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
