import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERMES_REF = "3c27eb6234bf91b8ceee9e9071591b31e9b148cb";

describe("Hermes install contract", () => {
  it("keeps container and local development on the same exact upstream ref", async () => {
    const [dockerfile, installer] = await Promise.all([
      readFile(`${REPO_ROOT}Dockerfile`, "utf8"),
      readFile(`${REPO_ROOT}scripts/install-clis.sh`, "utf8"),
    ]);

    expect(dockerfile).toContain(`ARG HERMES_AGENT_REF=${HERMES_REF}`);
    expect(installer).toContain(`HERMES_AGENT_REF="\${HERMES_AGENT_REF:-${HERMES_REF}}"`);
    expect(dockerfile).toContain("uv sync --project /usr/local/lib/hermes-agent");
    expect(installer).toContain('"$hermes_uv" sync --project "$HERMES_AGENT_INSTALL_DIR"');
    expect(dockerfile).toContain("--extra acp --extra mcp --no-dev --locked");
    expect(installer).toContain("--extra acp --extra mcp --no-dev --locked");
    expect(installer).toContain("uv 0.12 or newer");
    expect(installer).toContain('"$hermes_uv" sync');
  });

  it("uses Hermes' pinned MCP dependency and preserves the SDK's isError field", async () => {
    const dockerfile = await readFile(`${REPO_ROOT}Dockerfile`, "utf8");

    expect(dockerfile).not.toContain("uv tool install");
    expect(dockerfile).not.toContain("--with mcp");
    expect(dockerfile).not.toContain("result.is_error");
    expect(dockerfile).toContain("hasattr(result, 'isError')");
  });

  it("keeps the runtime immutable and disables network-backed lazy installs", async () => {
    const dockerfile = await readFile(`${REPO_ROOT}Dockerfile`, "utf8");

    expect(dockerfile).toContain("rm -rf /usr/local/lib/hermes-agent/.git");
    expect(dockerfile).toContain("HERMES_DISABLE_LAZY_INSTALLS=1");
  });
});
