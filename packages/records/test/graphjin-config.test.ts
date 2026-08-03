import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  acquireRecordsGraphjinConfigLock,
  buildRecordsGraphjinConfig,
  buildRecordsGraphjinRoleQuery,
  buildRecordsWatchGraphjinConfig,
  writeRecordsGraphjinConfig,
  type BuildRecordsGraphjinConfigInput,
} from "../src/graphjin/config";
import { projectRecordsGraphjinRoles } from "../src/policy/graphjin";
import { recordsPolicyFixture } from "./policy-fixture";

function configInput(): BuildRecordsGraphjinConfigInput {
  return {
    orgId: "org-a",
    roles: projectRecordsGraphjinRoles(recordsPolicyFixture()),
    database: {
      connectionString: "postgres://records:secret@records-db:5432/records?sslmode=disable",
      statementTimeoutMs: 4_000,
    },
    jwt: { secret: "jwt-secret-that-is-at-least-thirty-two-bytes" },
    secretKey: "cursor-secret-that-is-at-least-thirty-two-bytes",
  };
}

describe("records GraphJin config", () => {
  it("builds a standalone production config with a fail-closed fallback role", () => {
    const yaml = buildRecordsGraphjinConfig(configInput());
    const config = parse(yaml) as Record<string, any>;

    expect(config).not.toHaveProperty("sources");
    expect(config).toMatchObject({
      mode: "prod",
      production: true,
      host_port: "0.0.0.0:8090",
      reload_on_config_change: false,
      auth_fail_block: true,
      default_block: true,
      disable_allow_list: true,
      disable_production_security: true,
      analytics_mode: true,
      db_schema_poll_duration: "0s",
      caching: { disable: true },
      mcp: { disable: true, allow_mutations: false, allow_raw_queries: false },
      auth: { type: "jwt", development: false },
    });
    expect(config.database.connection_string).toContain(
      "options=-c+statement_timeout%3D4000",
    );
    expect(config.database.dbname).toBe("records");
    expect(config.roles_query).toBe(
      "SELECT role FROM engine.actor WHERE user_id = $user_id AND org_id = 'org-a' AND disabled_at IS NULL",
    );
    expect(config.roles.map((role: { name: string }) => role.name)).toEqual([
      "anon",
      "user",
      "member",
      "admin",
      "service",
    ]);
    const fallback = config.roles.find((role: { name: string }) => role.name === "user");
    expect(
      fallback.tables.every(
        (table: Record<string, { block: boolean }>) =>
          table.query.block &&
          table.insert.block &&
          table.update.block &&
          table.upsert.block &&
          table.delete.block,
      ),
    ).toBe(true);
  });

  it("builds an isolated read-only native watch plane with an exact webhook allowlist", () => {
    const allow = ["http://172.20.0.8:4100/admin/events/records-watch"];
    const config = parse(
      buildRecordsWatchGraphjinConfig({
        orgId: "org-a",
        database: configInput().database,
        jwt: { secret: "watch-jwt-secret-that-is-at-least-thirty-two-bytes" },
        secretKey: "watch-cursor-secret-that-is-at-least-thirty-two-bytes",
        watchWebhookAllow: allow,
      }),
    ) as Record<string, any>;

    expect(config).not.toHaveProperty("database");
    expect(config).not.toHaveProperty("roles");
    expect(config).not.toHaveProperty("roles_query");
    expect(config).toMatchObject({
      mode: "agentic",
      production: true,
      mcp: { disable: true, allow_mutations: false },
      identity: {
        namespace_claim: "org_id",
        admin_roles: ["records_watch_control_admin"],
      },
      artifacts: { enabled: true, source: "records", schema: "_graphjin" },
      watches: { enabled: true, runner: "all", webhook_allow: allow },
      sources: [
        {
          name: "records",
          kind: "database",
          access: {
            read: "account",
            write: "blocked",
            delete: "blocked",
            namespace_column: "org_id",
            missing_namespace_column: "block",
          },
        },
        {
          name: "graphjin",
          kind: "graphjin",
          control_plane: true,
          access: {
            roots: {
              gj_watch: "authenticated",
              gj_watch_event: "authenticated",
              gj_artifacts: "blocked",
            },
          },
        },
      ],
    });
  });

  it("escapes the org literal and rejects role-query characters GraphJin cannot parse", () => {
    expect(buildRecordsGraphjinRoleQuery("org'o")).toContain("org''o");
    expect(() => buildRecordsGraphjinRoleQuery("org-💥")).toThrow(/printable ASCII/);
  });

  it("refuses incomplete role projections before producing YAML", () => {
    const input = configInput();
    input.roles = input.roles.filter((role) => role.name !== "user");
    expect(() => buildRecordsGraphjinConfig(input)).toThrow(/missing roles: user/);
  });

  it("validates staging before atomic replacement and reloads afterward", async () => {
    const directory = await mkdtemp(join(tmpdir(), "records-config-test-"));
    const configFile = join(directory, "dev.yml");
    await writeFile(configFile, "old: true\n", { mode: 0o600 });
    const events: string[] = [];

    const result = await writeRecordsGraphjinConfig({
      configFile,
      config: configInput(),
      validate: async ({ configFile: staged }) => {
        events.push("validate");
        expect(await readFile(configFile, "utf8")).toBe("old: true\n");
        expect((await readFile(staged, "utf8")).length).toBeGreaterThan(100);
      },
      reloadRecordsGraphjin: async () => {
        events.push("reload");
        expect(await readFile(configFile, "utf8")).toContain("OpenNeko Records");
      },
    });

    expect(events).toEqual(["validate", "reload"]);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytes).toBeGreaterThan(100);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
  });

  it("retains the last good file and skips reload when validation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "records-config-failure-"));
    const configFile = join(directory, "dev.yml");
    await writeFile(configFile, "last_good: true\n", { mode: 0o600 });
    let reloaded = false;

    await expect(
      writeRecordsGraphjinConfig({
        configFile,
        config: configInput(),
        validate: async () => {
          throw new Error("invalid projection");
        },
        reloadRecordsGraphjin: async () => {
          reloaded = true;
        },
      }),
    ).rejects.toThrow("invalid projection");
    expect(await readFile(configFile, "utf8")).toBe("last_good: true\n");
    expect(reloaded).toBe(false);
  });

  it("serializes records config writers with its own lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "records-config-lock-"));
    const configFile = join(directory, "dev.yml");
    const release = await acquireRecordsGraphjinConfigLock(configFile);
    await expect(acquireRecordsGraphjinConfigLock(configFile)).rejects.toThrow(
      /another projection in progress/,
    );
    await release();
    const releaseAgain = await acquireRecordsGraphjinConfigLock(configFile);
    await releaseAgain();
  });
});
