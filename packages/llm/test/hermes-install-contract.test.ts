import { readFile, readdir } from "node:fs/promises";
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
    expect(dockerfile).toContain("uv tool install --python /usr/bin/python3");
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
    const runtimeContract = await readFile(
      `${REPO_ROOT}apps/worker/src/agent-sandbox/runtime-contract.ts`,
      "utf8",
    );

    expect(runtimeContract).toContain('env.HERMES_DISABLE_LAZY_INSTALLS = "1"');
  });

  it("keeps Hermes out of the worker while preserving its required runtime contracts", async () => {
    const dockerfile = await readFile(`${REPO_ROOT}Dockerfile`, "utf8");
    const sharedRuntime = dockerfile.slice(
      dockerfile.indexOf("FROM npm-runtime AS graphjin-node-runtime"),
      dockerfile.indexOf("FROM graphjin-node-runtime AS agent-base"),
    );
    const workerDeployStage = dockerfile.slice(
      dockerfile.indexOf("FROM source AS worker-deploy"),
      dockerfile.indexOf("FROM graphjin-node-runtime AS worker"),
    );
    const workerStage = dockerfile.slice(
      dockerfile.indexOf("FROM graphjin-node-runtime AS worker"),
      dockerfile.indexOf("FROM source AS agent-deploy"),
    );

    expect(sharedRuntime).toContain(
      "COPY --from=graphjin-bin /usr/local/bin/graphjin /usr/local/bin/graphjin",
    );
    expect(workerDeployStage).toContain("ONNXRUNTIME_NODE_INSTALL=skip");
    expect(workerStage).toContain(
      "ln -s /usr/bin/python3 /usr/local/uv/tools/hermes-agent/bin/python",
    );
    expect(workerStage).toContain("COPY --from=openshell-bin");
    expect(workerStage).not.toContain("uv tool install");
    expect(workerStage).not.toContain("COPY --from=agent-base");
    expect(workerStage).not.toContain("COPY --from=npm-payload");
  });

  it("ships the agent as the v2.28 production workspace closure", async () => {
    const dockerfile = await readFile(`${REPO_ROOT}Dockerfile`, "utf8");
    const agentDeploy = dockerfile.slice(
      dockerfile.indexOf("FROM source AS agent-deploy"),
      dockerfile.indexOf("FROM cli AS agent"),
    );
    const agentStage = dockerfile.slice(
      dockerfile.indexOf("FROM cli AS agent"),
      dockerfile.indexOf("# ─── 5c."),
    );

    expect(agentDeploy).toContain(
      "pnpm --filter @neko/worker deploy --prod /out/agent-app",
    );
    expect(agentDeploy).not.toContain("--outfile=/out/agent-app/agent-entry.js");
    expect(dockerfile).toContain("FROM npm-runtime AS agent-base");
    expect(dockerfile).not.toContain("FROM graphjin-node-runtime AS agent-base");
    expect(agentStage).toContain(
      "node --import tsx/esm /app/src/agent-sandbox/entry.ts",
    );
    expect(agentStage).not.toContain("/usr/local/bin/graphjin");
  });

  it("has no production GraphJin CLI execution fallback", async () => {
    const roots = [
      `${REPO_ROOT}packages/llm/src`,
      `${REPO_ROOT}apps/worker/src/agent-sandbox`,
    ];
    const files = (
      await Promise.all(
        roots.map(async (root) =>
          (await readdir(root, { recursive: true }))
            .filter((file) => file.endsWith(".ts"))
            .map((file) => `${root}/${file}`),
        ),
      )
    ).flat();
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join(
      "\n",
    );

    expect(source).not.toContain("graphjin cli execute_graphql");
    expect(source).not.toContain("OPENNEKO_GRAPHJIN_BIN");
    expect(source).not.toContain("OPENNEKO_GRAPHJIN_WRITE_GRANTS");
  });
});
