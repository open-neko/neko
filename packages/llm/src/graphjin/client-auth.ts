import { mkdir, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { mintGraphjinToken, GRAPHJIN_TOKEN_TTL_SECONDS } from "./token";

/**
 * GJ4 — per-run GraphJin client auth for the CLI path. The GraphJin CLI
 * reads `os.UserConfigDir()/graphjin/client.json` ({server, token}) and
 * sends `Authorization: Bearer <token>` on every MCP request. On Linux
 * that is usually `$XDG_CONFIG_HOME/graphjin/client.json`; on macOS it is
 * `$HOME/Library/Application Support/graphjin/client.json`. We write both
 * shapes under a per-run directory, and the graphjin-guard wrapper pins
 * both XDG_CONFIG_HOME and HOME at it — so each run's CLI calls carry
 * that run's actor token (K1 snapshot) and nothing else on the host can
 * read another run's token. Legacy mode (data_source.auth_mode='none')
 * skips all of this.
 */
export type GraphjinClientAuth = {
  /** Per-run config home the guard pins as XDG_CONFIG_HOME and HOME. */
  xdgConfigHome: string;
  token: string;
};

export async function provisionGraphjinClientAuth(opts: {
  /** Per-run dir to hold the config (e.g. the workspace runRoot). */
  runRoot: string;
  /** GraphJin MCP server URL (data_source.mcp_url). */
  serverUrl: string;
  orgId: string;
  userId: string | null;
  role: "admin" | "member" | "service";
}): Promise<GraphjinClientAuth> {
  const xdgConfigHome = join(opts.runRoot, "gj-auth");
  const token = mintGraphjinToken({
    orgId: opts.orgId,
    userId: opts.userId,
    role: opts.role,
  });
  const body = JSON.stringify(
    {
      server: opts.serverUrl,
      token,
      expires_at: new Date(
        Date.now() + GRAPHJIN_TOKEN_TTL_SECONDS * 1000,
      ).toISOString(),
      subject: opts.userId ?? "service",
    },
    null,
    2,
  );

  for (const dir of graphjinClientConfigDirs(xdgConfigHome)) {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "client.json");
    await writeFile(path, body, "utf8");
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort (non-POSIX)
    }
  }
  return { xdgConfigHome, token };
}

function graphjinClientConfigDirs(configHome: string): string[] {
  return [
    join(configHome, "graphjin"),
    join(configHome, ".config", "graphjin"),
    join(configHome, "Library", "Application Support", "graphjin"),
  ];
}
