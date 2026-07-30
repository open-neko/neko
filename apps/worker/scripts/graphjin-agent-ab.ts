/**
 * Reproducible launcher for the live GraphJin server-agent A/B experiment.
 *
 * It reads an existing encrypted Gemini credential through OpenNeko's normal
 * provider resolver, starts a temporary read-only GraphJin service on port
 * 8082, runs the focused Vitest experiment, writes a JSON report under
 * .openneko/experiments, and removes the exact temporary container.
 *
 * The credential is passed to Docker through process environment only. It is
 * never printed, placed in argv, or written to an experiment artifact.
 */

import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, db, eq, llm_provider_config } from "@neko/db";
import { resolvePrimaryProviderConfig } from "@neko/llm";
import pg from "pg";
import { GRAPHJIN_AB_CASES } from "./graphjin-agent-ab-cases";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const graphjinConfig = fileURLToPath(
  new URL("../../../db/graphjin/dev.example.yml", import.meta.url),
);
const graphjinImageDockerfile = fileURLToPath(
  new URL("./graphjin-agent-ab-graphjin.Dockerfile", import.meta.url),
);
const port = Number(process.env.GRAPHJIN_AGENT_AB_PORT || "8082");
const graphjinUrl = `http://localhost:${port}/api/v1/graphql`;
const containerName = `openneko-graphjin-agent-ab-${process.pid}`;
const reportPath = `${repoRoot}/.openneko/experiments/graphjin-agent-ab-20q-${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}.json`;
const agentTimeoutSeconds = Number(
  process.env.GRAPHJIN_AGENT_AB_TIMEOUT_SECONDS || "60",
);
const agentMaxSteps = Number(
  process.env.GRAPHJIN_AGENT_AB_MAX_STEPS || "6",
);

type CaseGroundTruth = {
  caseId: string;
  anchorDate: string;
  startDate: string;
  expectedValue: number;
  baselineValue: number;
  expectedDimension?: string;
};

type AgentProbe = {
  ok: boolean;
  durationMs: number;
  httpStatus?: number;
  responseStatus?: string;
  response?: {
    status?: string;
    answer?: string;
    data?: unknown;
    evidence?: unknown;
    usage?: unknown;
    errors?: Array<{ message?: string }>;
    next?: unknown;
  };
  error?: string;
};

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /([?&](?:key|api_key|access_token|token)=)[^&\s"'\\]+/giu,
      "$1[REDACTED]",
    )
    .replace(/AIza[0-9A-Za-z_-]+/gu, "[REDACTED_GOOGLE_API_KEY]");
}

function sanitizeForArtifact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "string" ? redactSensitiveText(nested) : nested,
    ),
  ) as T;
}

function commandExists(command: string): boolean {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: "inherit" | "ignore";
  } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function buildOpenNekoAgentImage(): Promise<string> {
  const explicit = process.env.OPENNEKO_AGENT_IMAGE?.trim();
  const shouldBuild =
    process.env.GRAPHJIN_AGENT_AB_BUILD_OPENNEKO_IMAGE === "1" || !explicit;
  const image = explicit || "openneko-agent:graphjin-ab";
  if (!shouldBuild) return image;

  console.log(
    `[graphjin-agent-ab] building OpenNeko agent image from branch as ${image}`,
  );
  const code = await run("docker", [
    "build",
    "--target",
    "agent",
    "--tag",
    image,
    repoRoot,
  ]);
  if (code !== 0) {
    throw new Error(`OpenNeko agent image build failed with exit code ${code}`);
  }
  return image;
}

async function resolveGraphjinImage(): Promise<{
  image: string;
  sourceVersion?: string;
}> {
  const explicit = process.env.GRAPHJIN_AGENT_AB_IMAGE?.trim();
  if (explicit) return { image: explicit };

  const source =
    process.env.GRAPHJIN_AGENT_AB_SOURCE?.trim() ||
    resolve(repoRoot, "../../Graphjin");
  if (!(await pathExists(join(source, "cmd")))) {
    return { image: "dosco/graphjin:3.18.42" };
  }
  if (!commandExists("go")) {
    throw new Error(
      `GraphJin source exists at ${source}, but the go command is unavailable`,
    );
  }

  const version =
    spawnSync("git", ["describe", "--always", "--tags", "--dirty"], {
      cwd: source,
      encoding: "utf8",
    }).stdout.trim() || "source";
  const image = "openneko-graphjin-agent-ab:local";
  const context = await mkdtemp(join(tmpdir(), "openneko-graphjin-agent-ab-"));
  try {
    const binary = join(context, "graphjin");
    console.log(
      `[graphjin-agent-ab] building GraphJin ${version} from ${source}`,
    );
    const goArch = process.arch === "arm64" ? "arm64" : "amd64";
    const buildCode = await run("go", ["build", "-o", binary, "./cmd"], {
      cwd: source,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: "linux",
        GOARCH: goArch,
        GOTOOLCHAIN: "auto",
      },
    });
    if (buildCode !== 0) {
      throw new Error(`GraphJin source build failed with exit code ${buildCode}`);
    }
    const imageCode = await run("docker", [
      "build",
      "--file",
      graphjinImageDockerfile,
      "--tag",
      image,
      context,
    ]);
    if (imageCode !== 0) {
      throw new Error(`GraphJin image build failed with exit code ${imageCode}`);
    }
    return { image, sourceVersion: version };
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

async function resolveGeminiCredential(): Promise<{
  apiKey: string;
  model: string;
}> {
  const [row] = await db()
    .select({ orgId: llm_provider_config.org_id })
    .from(llm_provider_config)
    .where(
      and(
        eq(llm_provider_config.scope, "primary"),
        eq(llm_provider_config.provider, "google-gemini"),
        eq(llm_provider_config.enabled, true),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      "No enabled google-gemini primary provider exists in OpenNeko settings.",
    );
  }
  const config = await resolvePrimaryProviderConfig(row.orgId);
  const apiKey = config.secrets.apiKey?.trim();
  if (!apiKey) {
    throw new Error("The configured google-gemini provider has no API key.");
  }
  return { apiKey, model: config.model };
}

async function loadGroundTruth(): Promise<CaseGroundTruth[]> {
  const pool = new pg.Pool({
    connectionString:
      process.env.GRAPHJIN_AGENT_AB_DATABASE_URL ||
      "postgresql://postgres:postgres@127.0.0.1:5433/adventureworks",
    max: 1,
  });
  try {
    const groundTruth: CaseGroundTruth[] = [];
    for (const definition of GRAPHJIN_AB_CASES) {
      const result = await pool.query<{
        anchor_date: string;
        start_date: string;
        expected_value: string;
        baseline_value: string;
        expected_dimension: string | null;
      }>(definition.groundTruthSql);
      const row = result.rows[0];
      const expectedValue = Number(row?.expected_value);
      const baselineValue = Number(row?.baseline_value);
      if (
        !row?.anchor_date ||
        !row.start_date ||
        !Number.isFinite(expectedValue) ||
        !Number.isFinite(baselineValue)
      ) {
        throw new Error(
          `AdventureWorks ground-truth query returned no usable row for ${definition.id}`,
        );
      }
      groundTruth.push({
        caseId: definition.id,
        anchorDate: row.anchor_date,
        startDate: row.start_date,
        expectedValue,
        baselineValue,
        ...(row.expected_dimension
          ? { expectedDimension: row.expected_dimension }
          : {}),
      });
    }
    return groundTruth;
  } finally {
    await pool.end();
  }
}

async function waitForAgent(): Promise<void> {
  const statusUrl = `http://localhost:${port}/api/v1/agent/status`;
  let last = "not reachable";
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const res = await fetch(statusUrl);
      const body = (await res.json()) as {
        ready?: boolean;
        read_only?: boolean;
        message?: string;
      };
      last = body.message || `HTTP ${res.status}`;
      if (res.ok && body.ready && body.read_only) return;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`GraphJin agent did not become ready: ${last}`);
}

async function probeAgent(): Promise<AgentProbe> {
  const startedAt = Date.now();
  const probeTimeoutMs = Math.min(
    Math.max(
      Number(process.env.GRAPHJIN_AGENT_AB_PROBE_TIMEOUT_MS || "70000"),
      10_000,
    ),
    180_000,
  );
  try {
    const res = await fetch(`http://localhost:${port}/api/v1/agent`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        instruction:
          "Using catalog-first discovery and read-only execution, find the latest sales order date in live data and return the total order count for the inclusive 365-day window ending on that date, plus the count for the immediately preceding 365-day window. Return compact typed data and evidence.",
        max_steps: agentMaxSteps,
        return_trace: false,
      }),
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    const text = await res.text();
    let body: NonNullable<AgentProbe["response"]> = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        httpStatus: res.status,
        error: `invalid JSON response: ${text.slice(0, 300)}`,
      };
    }
    const responseStatus = body.status;
    const ok = res.ok && responseStatus === "answered";
    return sanitizeForArtifact({
      ok,
      durationMs: Date.now() - startedAt,
      httpStatus: res.status,
      responseStatus,
      response: body,
      ...(!ok
        ? {
            error:
              body.errors
                ?.map((item) => item.message)
                .filter(Boolean)
                .join("; ") ||
              `GraphJin returned status=${responseStatus || "unknown"}`,
          }
        : {}),
    });
  } catch (cause) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: redactSensitiveText(
        cause instanceof Error ? cause.message : String(cause),
      ),
    };
  }
}

function printContainerLogs(container: string): void {
  const result = spawnSync("docker", ["logs", "--tail", "120", container], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const logs = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (logs) console.error(redactSensitiveText(logs));
}

async function removeContainer(): Promise<void> {
  await run("docker", ["rm", "--force", containerName], {
    stdio: "ignore",
  }).catch(() => {});
}

async function main(): Promise<void> {
  for (const command of ["docker", "openshell", "hermes"]) {
    if (!commandExists(command)) {
      throw new Error(`Required command is not on PATH: ${command}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid GRAPHJIN_AGENT_AB_PORT: ${port}`);
  }
  if (
    !Number.isInteger(agentTimeoutSeconds) ||
    agentTimeoutSeconds < 50 ||
    agentTimeoutSeconds > 300
  ) {
    throw new Error(
      `GRAPHJIN_AGENT_AB_TIMEOUT_SECONDS must be an integer from 50 to 300: ${agentTimeoutSeconds}`,
    );
  }
  if (
    !Number.isInteger(agentMaxSteps) ||
    agentMaxSteps < 1 ||
    agentMaxSteps > 12
  ) {
    throw new Error(
      `GRAPHJIN_AGENT_AB_MAX_STEPS must be an integer from 1 to 12: ${agentMaxSteps}`,
    );
  }

  const credential = await resolveGeminiCredential();
  const groundTruth = await loadGroundTruth();
  const openNekoAgentImage = await buildOpenNekoAgentImage();
  const graphjinBuild = await resolveGraphjinImage();
  const image = graphjinBuild.image;
  const model =
    process.env.GRAPHJIN_AGENT_AB_MODEL || credential.model || "gemini-3.6-flash";
  const network =
    process.env.GRAPHJIN_AGENT_AB_NETWORK || "openneko_default";

  console.log(
    `[graphjin-agent-ab] starting isolated ${image} on :${port} (model=${model}, read_only=true, timeout=${agentTimeoutSeconds}s, max_steps=${agentMaxSteps})`,
  );
  console.log(
    `[graphjin-agent-ab] loaded ground truth for ${groundTruth.length} questions`,
  );
  const dockerEnv = {
    ...process.env,
    GRAPHJIN_AGENT_API_KEY: credential.apiKey,
  };
  const started = await run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--network",
      network,
      "--publish",
      `${port}:8080`,
      "--env",
      "GRAPHJIN_AGENT_API_KEY",
      "--env",
      "GO_ENV=development",
      "--env",
      "GJ_DATABASE_HOST=adventureworks-db",
      "--env",
      "GJ_DATABASE_PORT=5432",
      "--env",
      "GJ_DATABASE_USER=postgres",
      "--env",
      "GJ_DATABASE_PASSWORD=postgres",
      "--env",
      "GJ_DATABASE_DBNAME=adventureworks",
      "--env",
      "GJ_AGENT_ENABLED=true",
      "--env",
      "GJ_AGENT_PROVIDER=google-gemini",
      "--env",
      `GJ_AGENT_MODEL=${model}`,
      "--env",
      "GJ_AGENT_API_KEY_ENV=GRAPHJIN_AGENT_API_KEY",
      "--env",
      `GJ_AGENT_MAX_STEPS=${agentMaxSteps}`,
      "--env",
      `GJ_AGENT_TIMEOUT_SECONDS=${agentTimeoutSeconds}`,
      "--env",
      "GJ_AGENT_READ_ONLY=true",
      "--env",
      "GJ_AGENT_RETURN_TRACE=false",
      "--volume",
      `${graphjinConfig}:/config/dev.yml:ro`,
      image,
      "serve",
      "--path",
      "/config",
    ],
    { env: dockerEnv, stdio: "ignore" },
  );
  if (started !== 0) {
    throw new Error(`docker run failed with exit code ${started}`);
  }

  try {
    await waitForAgent();
    console.log("[graphjin-agent-ab] GraphJin agent is ready");
    const probe = await probeAgent();
    console.log(
      `[graphjin-agent-ab] inner-agent probe=${probe.ok ? "passed" : "failed"} duration=${(probe.durationMs / 1_000).toFixed(1)}s${
        probe.error ? ` error=${redactSensitiveText(probe.error)}` : ""
      }`,
    );
    if (!probe.ok) {
      printContainerLogs(containerName);
    }

    const testEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GEMINI_API_KEY: credential.apiKey,
      NEKO_GRAPHJIN_AGENT_AB_URL: graphjinUrl,
      NEKO_GRAPHJIN_AB_REPORT: reportPath,
      NEKO_GRAPHJIN_AGENT_AB_GROUND_TRUTH: JSON.stringify(groundTruth),
      ...(process.env.GRAPHJIN_AGENT_AB_CASE_IDS
        ? {
            NEKO_GRAPHJIN_AGENT_AB_CASE_IDS:
              process.env.GRAPHJIN_AGENT_AB_CASE_IDS,
          }
        : {}),
      ...(process.env.GRAPHJIN_AGENT_AB_ARMS
        ? {
            NEKO_GRAPHJIN_AGENT_AB_ARMS:
              process.env.GRAPHJIN_AGENT_AB_ARMS,
          }
        : {}),
      ...(process.env.GRAPHJIN_AGENT_AB_BASELINE_REPORT
        ? {
            NEKO_GRAPHJIN_AGENT_AB_BASELINE_REPORT:
              process.env.GRAPHJIN_AGENT_AB_BASELINE_REPORT,
          }
        : {}),
      NEKO_GRAPHJIN_AGENT_AB_PREFLIGHT: JSON.stringify(probe),
      NEKO_GRAPHJIN_AGENT_AB_IMAGE: image,
      ...(graphjinBuild.sourceVersion
        ? {
            NEKO_GRAPHJIN_AGENT_AB_SOURCE_VERSION:
              graphjinBuild.sourceVersion,
          }
        : {}),
      NEKO_GRAPHJIN_AGENT_AB_MODEL: model,
      NEKO_E2E_HERMES_MODEL: credential.model,
      NEKO_E2E_HERMES_OPENSHELL_PROVIDER:
        process.env.NEKO_E2E_HERMES_OPENSHELL_PROVIDER || "openneko-gemini",
      OPENNEKO_AGENT_IMAGE: openNekoAgentImage,
      NEKO_GRAPHJIN_AGENT_AB_OPENNEKO_IMAGE: openNekoAgentImage,
    };

    const code = await run(
      "pnpm",
      [
        "--filter",
        "@neko/worker",
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.e2e.config.ts",
        "test/e2e/graphjin-agent-ab.test.ts",
      ],
      { env: testEnv },
    );
    console.log(`[graphjin-agent-ab] report=${reportPath}`);
    if (code !== 0) process.exitCode = code;
  } catch (cause) {
    printContainerLogs(containerName);
    throw cause;
  } finally {
    await removeContainer();
  }
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void removeContainer().finally(() => process.exit(130));
  });
}

void main().catch(async (cause) => {
  await removeContainer();
  console.error(
    `[graphjin-agent-ab] ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  process.exitCode = 1;
});
