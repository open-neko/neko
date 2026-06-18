import { writeFile, readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The stdin->stdout compactor the wrapper pipes GraphJin output through. Copied
// next to the wrapper at setup so it resolves under plain `node` in the sandbox.
const COMPACT_CLI_SOURCE = fileURLToPath(
  new URL("./tool-output/compact-cli.mjs", import.meta.url),
);

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
    /** GJ4: pin the CLI at a per-run config dir (gj-auth/graphjin/
     *  client.json carries this run's actor token). Defaults to the
     *  process XDG so legacy runs are unchanged. */
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
  await writeFile(compactCliPath, await readFile(COMPACT_CLI_SOURCE), { mode: 0o755 });
  await writeFile(wrapperPath, script, { encoding: "utf8", mode: 0o755 });
  return wrapperPath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function resolveBinaryOnPath(name: string): Promise<string | null> {
  const pathValue = process.env.PATH || "";
  for (const entry of pathValue.split(":")) {
    if (!entry) continue;
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
