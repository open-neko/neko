import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HERMES_REF = "a91a57fa5a13d516c38b07a141a9ce8a3daabeb0";

describe("Hermes install contract", () => {
  it("keeps container and local development on the same exact upstream ref", async () => {
    const [dockerfile, installer] = await Promise.all([
      readFile(`${REPO_ROOT}Dockerfile`, "utf8"),
      readFile(`${REPO_ROOT}scripts/install-clis.sh`, "utf8"),
    ]);

    expect(dockerfile).toContain(`ARG HERMES_AGENT_REF=${HERMES_REF}`);
    expect(installer).toContain(`HERMES_AGENT_REF="\${HERMES_AGENT_REF:-${HERMES_REF}}"`);
    expect(dockerfile).toContain("uv tool install --python 3.11");
    expect(installer).toContain("uv tool install --force --python 3.11");
    expect(dockerfile).toContain("--with mcp --with websockets");
    expect(installer).toContain("--with mcp --with websockets");
    expect(dockerfile).not.toContain("uv sync --project /usr/local/lib/hermes-agent");
    expect(installer).not.toContain("uv 0.12 or newer");
    expect(dockerfile).toContain("hermes_cli.__version__ == '0.14.0'");
    expect(installer).toContain("HERMES_AGENT_VERSION=\"0.14.0\"");
  });

  it("patches v0.14's MCP adapter for the SDK's snake_case is_error field", async () => {
    const [dockerfile, installer] = await Promise.all([
      readFile(`${REPO_ROOT}Dockerfile`, "utf8"),
      readFile(`${REPO_ROOT}scripts/install-clis.sh`, "utf8"),
    ]);

    expect(dockerfile).toContain("result.is_error");
    expect(installer).toContain("result.is_error");
    expect(dockerfile).toContain("hasattr(result, 'is_error')");
    expect(installer).toContain("hasattr(result, 'is_error')");
    expect(dockerfile).toContain("assert 'usage=usage' in source");
    expect(installer).toContain("assert 'usage=usage' in source");
  });

  it("disables network-backed lazy installs in the runtime", async () => {
    const dockerfile = await readFile(`${REPO_ROOT}Dockerfile`, "utf8");

    expect(dockerfile).toContain("HERMES_DISABLE_LAZY_INSTALLS=1");
  });
});
