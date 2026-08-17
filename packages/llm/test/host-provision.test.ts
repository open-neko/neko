import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  clearProvider,
  createTestOrg,
  dbReachable,
  deleteTestOrg,
  seedDataSource,
  seedProvider,
  uniqueOrgId,
} from "@neko/db/test-helpers";
import { db, eq, data_source, pool } from "@neko/db";
import {
  ensureHostConfigProvisioned,
  hermesHomeForOrg,
  patchGraphjinSourcesJwtSecret,
  provisionHostConfig,
  resolveHermesModelBinary,
  shouldReconcileDemoSourceAuthMode,
} from "../src/host-provision";
import { ensureOpenShellProvider } from "../src/work/sandbox-launcher";
import { graphjinSigningSecretB64 } from "../src/graphjin/token";

vi.mock("../src/work/sandbox-launcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/work/sandbox-launcher")>();
  return {
    ...actual,
    ensureOpenShellProvider: vi.fn().mockResolvedValue(undefined),
  };
});

const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn(
    "[host-provision] skipping: metadata Postgres unreachable. Run `docker compose up -d`.",
  );
}

function graphjinPath(home: string): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return join(xdg, "graphjin", "client.json");
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "graphjin", "client.json");
  }
  return join(home, ".config", "graphjin", "client.json");
}

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HERMES_HOME = process.env.HERMES_HOME;
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const DELEGATION_ENV_KEYS = [
  "OPENNEKO_AGENT_DELEGATION_MAX_ITERATIONS",
  "OPENNEKO_AGENT_DELEGATION_MAX_CONCURRENT_CHILDREN",
  "OPENNEKO_AGENT_DELEGATION_MAX_SPAWN_DEPTH",
  "OPENNEKO_AGENT_DELEGATION_CHILD_TIMEOUT_SECONDS",
  "OPENNEKO_AGENT_DELEGATION_ORCHESTRATOR_ENABLED",
] as const;
const ORIGINAL_DELEGATION_ENV = Object.fromEntries(
  DELEGATION_ENV_KEYS.map((key) => [key, process.env[key]]),
);
const ensureOpenShellProviderMock = vi.mocked(ensureOpenShellProvider);

describe("resolveHermesModelBinary", () => {
  it("returns the exact interpreter behind Hermes' uv entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "neko-hermes-python-"));
    try {
      const interpreter = join(root, "cpython-3.11.16", "bin", "python3.11");
      const entrypoint = join(root, "hermes-python");
      await mkdir(join(root, "cpython-3.11.16", "bin"), { recursive: true });
      await writeFile(interpreter, "python");
      await symlink(interpreter, entrypoint);

      expect(resolveHermesModelBinary(entrypoint)).toBe(
        await realpath(interpreter),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reintroduce a guessed Python patch version when absent", () => {
    const missing = "/missing/hermes-agent/bin/python";
    expect(resolveHermesModelBinary(missing)).toBe(missing);
  });
});

describe("patchGraphjinSourcesJwtSecret", () => {
  it("replaces a source-mode placeholder", () => {
    const raw = `auth:
  type: jwt
  jwt:
    secret: "REPLACE_WITH_PER_ORG_SECRET_B64"
`;

    expect(patchGraphjinSourcesJwtSecret(raw, "new-secret")).toEqual({
      changed: true,
      content: `auth:
  type: jwt
  jwt:
    secret: "new-secret"
`,
    });
  });

  it("repairs a stale concrete source-mode secret", () => {
    const raw = `auth:
  type: jwt
  jwt:
    # base64 of graphjinSigningSecretB64(orgId)
    secret: "old-secret"
    audience: ""
`;

    expect(patchGraphjinSourcesJwtSecret(raw, "new-secret")).toEqual({
      changed: true,
      content: `auth:
  type: jwt
  jwt:
    # base64 of graphjinSigningSecretB64(orgId)
    secret: "new-secret"
    audience: ""
`,
    });
  });

  it("leaves matching source-mode secrets untouched", () => {
    const raw = `auth:
  type: jwt
  jwt:
    secret: "same-secret"
`;

    expect(patchGraphjinSourcesJwtSecret(raw, "same-secret")).toEqual({
      changed: false,
      content: raw,
    });
  });
});

describe("shouldReconcileDemoSourceAuthMode", () => {
  const jwtConfig = `auth:
  type: jwt
  jwt:
    secret: "demo-secret"
`;

  it("recognizes the mount used by older packaged demo compose files", () => {
    expect(
      shouldReconcileDemoSourceAuthMode(
        "/graphjin-config/agentic.yml",
        jwtConfig,
        "",
      ),
    ).toBe(true);
  });

  it("recognizes an explicitly marked demo with a custom config path", () => {
    expect(
      shouldReconcileDemoSourceAuthMode("/custom/agentic.yml", jwtConfig, "demo"),
    ).toBe(true);
  });

  it("does not reconcile the production GraphJin config", () => {
    expect(
      shouldReconcileDemoSourceAuthMode(
        "/config/graphjin/agentic.yml",
        jwtConfig,
        "",
      ),
    ).toBe(false);
  });

  it("does not trust a demo config that is not JWT-enabled", () => {
    expect(
      shouldReconcileDemoSourceAuthMode(
        "/graphjin-config/agentic.yml",
        "auth:\n  type: none\n",
        "",
      ),
    ).toBe(false);
  });
});

describeIfDb("provisionHostConfig", () => {
  let orgId: string;
  let tempHome: string;
  let hermesHome: string;

  beforeAll(async () => {
    orgId = uniqueOrgId("provision");
    await createTestOrg(orgId);
  });

  afterAll(async () => {
    await deleteTestOrg(orgId);
  });

  beforeEach(async () => {
    ensureOpenShellProviderMock.mockReset();
    ensureOpenShellProviderMock.mockResolvedValue(undefined);
    tempHome = await mkdtemp(join(tmpdir(), "neko-test-home-"));
    hermesHome = join(tempHome, ".hermes");
    process.env.HOME = tempHome;
    process.env.HERMES_HOME = hermesHome;
    delete process.env.XDG_CONFIG_HOME;
    for (const key of DELEGATION_ENV_KEYS) delete process.env[key];
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
    if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_HERMES_HOME) process.env.HERMES_HOME = ORIGINAL_HERMES_HOME;
    else delete process.env.HERMES_HOME;
    if (ORIGINAL_XDG_CONFIG_HOME) process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
    else delete process.env.XDG_CONFIG_HOME;
    for (const key of DELEGATION_ENV_KEYS) {
      const original = ORIGINAL_DELEGATION_ENV[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    await clearProvider(orgId, "agent");
    await clearProvider(orgId, "primary");
    await db().delete(data_source).where(eq(data_source.org_id, orgId));
  });

  it("writes graphjin client.json with the server base derived from graphql_url", async () => {
    await seedDataSource(orgId, {
      graphqlUrl: "http://localhost:8080/api/v1/graphql",
    });
    await provisionHostConfig(orgId);

    const path = graphjinPath(tempHome);
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.server).toBe("http://localhost:8080");
    expect(content.token).toBe("");
    expect(content.expires_at).toBe("0001-01-01T00:00:00Z");
  });

  it("writes graphjin client.json under XDG_CONFIG_HOME when it is set", async () => {
    process.env.XDG_CONFIG_HOME = join(tempHome, "xdg-config");
    await seedDataSource(orgId, {
      graphqlUrl: "http://graphjin:8080/api/v1/graphql",
    });

    await provisionHostConfig(orgId);

    const path = graphjinPath(tempHome);
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(path).toBe(join(tempHome, "xdg-config", "graphjin", "client.json"));
    expect(content.server).toBe("http://graphjin:8080");
  });

  it("falls back to URL origin when graphql path doesn't match the conventional suffix", async () => {
    await seedDataSource(orgId, {
      graphqlUrl: "https://api.example.com/custom-path",
    });
    await provisionHostConfig(orgId);

    const path = graphjinPath(tempHome);
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.server).toBe("https://api.example.com");
  });

  it("writes hermes config.yaml + .env when backend=hermes", async () => {
    await seedDataSource(orgId);
    await seedProvider(orgId, {
      scope: "agent",
      provider: "hermes",
      config: { backend: "hermes" },
    });
    await seedProvider(orgId, {
      scope: "primary",
      provider: "google-gemini",
      model: "gemini-pro-latest",
      secrets: { apiKey: "test-gemini-key" },
    });

    await provisionHostConfig(orgId);

    const yaml = await readFile(join(hermesHome, "config.yaml"), "utf8");
    expect(yaml).toContain('default: "gemini-pro-latest"');
    expect(yaml).toContain('provider: "gemini"');
    expect(yaml).toContain("max_turns:");
    expect(yaml).toContain("delegation:");
    expect(yaml).toContain("max_iterations: 50");
    expect(yaml).toContain("max_concurrent_children: 3");
    expect(yaml).toContain("max_spawn_depth: 1");
    expect(yaml).toContain("orchestrator_enabled: true");
    expect(yaml).toContain("child_timeout_seconds: 0");

    const env = await readFile(join(hermesHome, ".env"), "utf8");
    expect(env).toContain("GEMINI_API_KEY=test-gemini-key");

    const envStat = await stat(join(hermesHome, ".env"));
    expect(envStat.mode & 0o777).toBe(0o600);
  });

  it("honors and clamps Hermes delegation env overrides", async () => {
    process.env.OPENNEKO_AGENT_DELEGATION_MAX_ITERATIONS = "17.9";
    process.env.OPENNEKO_AGENT_DELEGATION_MAX_CONCURRENT_CHILDREN = "5";
    process.env.OPENNEKO_AGENT_DELEGATION_MAX_SPAWN_DEPTH = "99";
    process.env.OPENNEKO_AGENT_DELEGATION_CHILD_TIMEOUT_SECONDS = "-10";
    process.env.OPENNEKO_AGENT_DELEGATION_ORCHESTRATOR_ENABLED = "off";
    await seedDataSource(orgId);
    await seedProvider(orgId, {
      scope: "agent",
      provider: "hermes",
      config: { backend: "hermes" },
    });
    await seedProvider(orgId, {
      scope: "primary",
      provider: "google-gemini",
      model: "gemini-pro-latest",
      secrets: { apiKey: "test-gemini-key" },
    });

    await provisionHostConfig(orgId);

    const yaml = await readFile(join(hermesHome, "config.yaml"), "utf8");
    expect(yaml).toContain("delegation:");
    expect(yaml).toContain("max_iterations: 17");
    expect(yaml).toContain("max_concurrent_children: 5");
    expect(yaml).toContain("max_spawn_depth: 3");
    expect(yaml).toContain("orchestrator_enabled: false");
    expect(yaml).toContain("child_timeout_seconds: 0");
  });

  it("writes anthropic key var for anthropic provider", async () => {
    await seedDataSource(orgId);
    await seedProvider(orgId, {
      scope: "agent",
      provider: "hermes",
      config: { backend: "hermes" },
    });
    await seedProvider(orgId, {
      scope: "primary",
      provider: "anthropic",
      model: "claude-opus-4-7",
      secrets: { apiKey: "sk-ant-test" },
    });

    await provisionHostConfig(orgId);

    const yaml = await readFile(join(hermesHome, "config.yaml"), "utf8");
    expect(yaml).toContain('provider: "anthropic"');
    const env = await readFile(join(hermesHome, ".env"), "utf8");
    expect(env).toContain("ANTHROPIC_API_KEY=sk-ant-test");
  });

  it("skips hermes writes when backend=claude-agent (only graphjin written)", async () => {
    await seedDataSource(orgId);
    await seedProvider(orgId, {
      scope: "agent",
      provider: "claude-agent",
      config: { backend: "claude-agent" },
    });
    await seedProvider(orgId, {
      scope: "primary",
      provider: "anthropic",
      model: "claude-opus-4-7",
      secrets: { apiKey: "sk-ant-claude-agent" },
    });

    await provisionHostConfig(orgId);

    const gj = await readFile(graphjinPath(tempHome), "utf8");
    expect(gj).toContain("server");

    await expect(readFile(join(hermesHome, "config.yaml"), "utf8")).rejects.toThrow();
    await expect(readFile(join(hermesHome, ".env"), "utf8")).rejects.toThrow();
  });

  it("does not throw when primary row is missing (best-effort)", async () => {
    await seedDataSource(orgId);
    await seedProvider(orgId, {
      scope: "agent",
      provider: "hermes",
      config: { backend: "hermes" },
    });
    await expect(provisionHostConfig(orgId)).resolves.toBeUndefined();
    await readFile(graphjinPath(tempHome), "utf8");
  });

  it("does not throw when no data source exists (graphjin write skipped)", async () => {
    await expect(provisionHostConfig(orgId)).resolves.toBeUndefined();
  });

  it("repairs an existing packaged-demo AdventureWorks source deterministically", async () => {
    const configPath = join(tempHome, "agentic.yml");
    await writeFile(
      configPath,
      `auth:
  type: jwt
  jwt:
    secret: "${graphjinSigningSecretB64(orgId)}"
`,
      "utf8",
    );
    await seedDataSource(orgId, { label: "AdventureWorks" });

    const previousPath = process.env.OPENNEKO_GRAPHJIN_CONFIG;
    const previousMode = process.env.OPENNEKO_STACK_MODE;
    process.env.OPENNEKO_GRAPHJIN_CONFIG = configPath;
    process.env.OPENNEKO_STACK_MODE = "demo";
    try {
      await provisionHostConfig(orgId);
    } finally {
      if (previousPath === undefined) delete process.env.OPENNEKO_GRAPHJIN_CONFIG;
      else process.env.OPENNEKO_GRAPHJIN_CONFIG = previousPath;
      if (previousMode === undefined) delete process.env.OPENNEKO_STACK_MODE;
      else process.env.OPENNEKO_STACK_MODE = previousMode;
    }

    const [source] = await db()
      .select({ authMode: data_source.auth_mode })
      .from(data_source)
      .where(eq(data_source.org_id, orgId));
    expect(source?.authMode).toBe("jwt");
  });

  it("writes hermes config under ~/.config/openneko/hermes/{orgId} when HERMES_HOME is unset", async () => {
    delete process.env.HERMES_HOME;
    await seedDataSource(orgId);
    await seedProvider(orgId, {
      scope: "agent",
      provider: "hermes",
      config: { backend: "hermes" },
    });
    await seedProvider(orgId, {
      scope: "primary",
      provider: "google-gemini",
      model: "gemini-pro-latest",
      secrets: { apiKey: "test-default-path-key" },
    });

    await provisionHostConfig(orgId);

    const expectedHome = join(tempHome, ".config", "openneko", "hermes", orgId);
    expect(hermesHomeForOrg(orgId)).toBe(expectedHome);

    const yaml = await readFile(join(expectedHome, "config.yaml"), "utf8");
    expect(yaml).toContain('default: "gemini-pro-latest"');
    const env = await readFile(join(expectedHome, ".env"), "utf8");
    expect(env).toContain("GEMINI_API_KEY=test-default-path-key");

    expect(hermesHomeForOrg("other-org")).toBe(
      join(tempHome, ".config", "openneko", "hermes", "other-org"),
    );
  });

  it("writes empty .env when key is missing but provider row exists", async () => {
    await seedDataSource(orgId);
    await seedProvider(orgId, {
      scope: "agent",
      provider: "hermes",
      config: { backend: "hermes" },
    });
    await seedProvider(orgId, {
      scope: "primary",
      provider: "google-gemini",
      model: "gemini-pro-latest",
      secrets: {},
    });

    await provisionHostConfig(orgId);

    const env = await readFile(join(hermesHome, ".env"), "utf8");
    expect(env).toBe("");
  });

  it("keeps direct provisioning best-effort when OpenShell provider sync fails", async () => {
    ensureOpenShellProviderMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    await seedDataSource(orgId);
    await seedProvider(orgId, {
      scope: "agent",
      provider: "hermes",
      config: { backend: "hermes" },
    });
    await seedProvider(orgId, {
      scope: "primary",
      provider: "google-gemini",
      model: "gemini-pro-latest",
      secrets: { apiKey: "test-gemini-key" },
    });

    await expect(provisionHostConfig(orgId)).resolves.toBeUndefined();
    expect(ensureOpenShellProviderMock).toHaveBeenCalledTimes(1);

    const yaml = await readFile(join(hermesHome, "config.yaml"), "utf8");
    expect(yaml).toContain('provider: "gemini"');
  });

  it("retries memoized provisioning after an OpenShell provider sync failure", async () => {
    const retryOrgId = uniqueOrgId("provision-retry");
    await createTestOrg(retryOrgId);
    try {
      await seedDataSource(retryOrgId);
      await seedProvider(retryOrgId, {
        scope: "agent",
        provider: "hermes",
        config: { backend: "hermes" },
      });
      await seedProvider(retryOrgId, {
        scope: "primary",
        provider: "google-gemini",
        model: "gemini-pro-latest",
        secrets: { apiKey: "test-gemini-key" },
      });
      ensureOpenShellProviderMock
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockResolvedValueOnce(undefined);

      await expect(ensureHostConfigProvisioned(retryOrgId)).rejects.toThrow(
        "gateway unavailable",
      );
      await expect(ensureHostConfigProvisioned(retryOrgId)).resolves.toBeUndefined();

      expect(ensureOpenShellProviderMock).toHaveBeenCalledTimes(2);
    } finally {
      await deleteTestOrg(retryOrgId);
    }
  });
});

if (reachable) {
  afterAll(async () => {
    await pool().end();
  });
}
