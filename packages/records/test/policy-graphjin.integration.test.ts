import pg from "pg";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import {
  createRecordsGraphjinConfigValidator,
  writeRecordsGraphjinConfig,
} from "../src/graphjin/config";
import {
  loadRecordsGraphjinPolicyModel,
  projectRecordsGraphjinRoles,
} from "../src/policy/graphjin";
import { buildRecordListQuery } from "../src/read/query";
import { RecordRegistry } from "../src/registry";

async function recordsDbReachable(): Promise<boolean> {
  const probe = new pg.Pool(buildRecordsPoolConfig());
  try {
    await probe.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

const reachable = await recordsDbReachable();
const describeIfRecordsDb = reachable ? describe : describe.skip;
const graphjinBinary = process.env.RECORDS_GRAPHJIN_BIN;
const graphjinImage = process.env.RECORDS_GRAPHJIN_IMAGE;
const itIfGraphjin = graphjinBinary || graphjinImage ? it : it.skip;
const itIfGraphjinImage = graphjinImage ? it : it.skip;
const LIVE_JWT_SECRET = "live-jwt-secret-that-is-at-least-thirty-two-bytes";

function runTestCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 30_000, env: { ...process.env, GO_ENV: "development" } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr) || error.message));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function validateWithTestGraphjin(configDirectory: string): Promise<void> {
  if (graphjinImage) {
    const version = await runTestCommand("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "graphjin",
      graphjinImage,
      "version",
    ]);
    expect(version.stdout).toContain("GraphJin 3.18.42");
    await runTestCommand("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "graphjin",
      "-v",
      `${configDirectory}:/config:ro`,
      graphjinImage,
      "serve",
      "test",
      "--json",
      "--path",
      "/config",
    ]);
    return;
  }
  await createRecordsGraphjinConfigValidator({ binary: graphjinBinary! })({
    configDirectory,
    configFile: join(configDirectory, "dev.yml"),
  });
}

function graphjinJwt(userId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: userId,
    iat: Math.floor(Date.now() / 1_000),
    exp: Math.floor(Date.now() / 1_000) + 300,
  })}`;
  const signature = createHmac("sha256", LIVE_JWT_SECRET)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

if (!reachable) {
  console.warn("[records-policy] skipping: records Postgres unreachable.");
}

describeIfRecordsDb("records GraphJin live-catalog policy integration", () => {
  const database = `records_policy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    testPool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    await runRecordsMigrations({ pool: testPool });
    await testPool.query(`
      create table public.equipment__loan (
        id text primary key,
        org_id text not null,
        name text not null,
        owner_user_id text,
        nk_created_at timestamptz not null default now(),
        nk_updated_at timestamptz not null default now(),
        nk_deleted_at timestamptz
      );
      create table public.unregistered_secret (id text primary key, secret text);
      insert into engine.record_app (org_id, app_id, label, status)
      values ('org-a', 'equipment', 'Equipment', 'active');
      insert into engine.record_object
        (id, org_id, app_id, api_name, label, plural_label, table_name,
         name_field, visibility)
      values
        ('00000000-0000-0000-0000-000000000201', 'org-a', 'equipment',
         'loan', 'Loan', 'Loans', 'equipment__loan', 'name', 'owner');
      insert into engine.record_field
        (org_id, object_id, api_name, label, kind, column_name, required)
      values
        ('org-a', '00000000-0000-0000-0000-000000000201',
         'name', 'Name', 'text', 'name', true);
      insert into engine.record_permission
        (org_id, app_id, role, object_api_name, can_read)
      values
        ('org-a', 'equipment', 'member', 'loan', true),
        ('org-a', 'equipment', 'admin', 'loan', true);
      insert into engine.actor (org_id, user_id, role) values
        ('org-a', 'member-1', 'member'),
        ('org-a', 'member-2', 'member'),
        ('org-a', 'admin-1', 'admin'),
        ('org-a', 'service-1', 'service');
      insert into public.equipment__loan (id, org_id, name, owner_user_id) values
        ('loan-1', 'org-a', 'Member One Loan', 'member-1'),
        ('loan-2', 'org-a', 'Member Two Loan', 'member-2');
    `);
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database} with (force)`);
      await adminPool.end();
    }
  });

  it("uses the live catalog as the exhaustive universe", async () => {
    const model = await loadRecordsGraphjinPolicyModel(testPool, "org-a");
    const roles = projectRecordsGraphjinRoles(model);
    const liveRelations = model.catalog.map((table) => `${table.schema}.${table.name}`);

    expect(liveRelations).toContain("public.equipment__loan");
    expect(liveRelations).toContain("public.unregistered_secret");
    expect(liveRelations).toContain("engine.actor");
    for (const role of roles) expect(role.tables).toHaveLength(model.catalog.length);

    const member = roles.find((role) => role.name === "member")!;
    expect(member.tables.find((table) => table.name === "equipment__loan")?.query).toMatchObject({
      block: false,
      filters: expect.arrayContaining(["{ owner_user_id: { eq: $user_id } }"]),
    });
    expect(member.tables.find((table) => table.name === "unregistered_secret")?.query.block).toBe(
      true,
    );
    expect(member.tables.find((table) => table.name === "actor")?.query.block).toBe(true);
  });

  itIfGraphjin(
    "loads the complete config in pinned GraphJin",
    async () => {
      const model = await loadRecordsGraphjinPolicyModel(testPool, "org-a");
      const directory = await mkdtemp(join(tmpdir(), "records-graphjin-live-"));
      const poolConfig = buildRecordsPoolConfig(process.env, { database });
      const connection = new URL("postgres://localhost/records");
      connection.hostname = graphjinImage
        ? (process.env.RECORDS_GRAPHJIN_DB_HOST ?? "host.internal")
        : String(poolConfig.host);
      connection.port = String(poolConfig.port);
      connection.username = String(poolConfig.user);
      connection.password = String(poolConfig.password ?? "");
      connection.pathname = `/${database}`;
      connection.searchParams.set("sslmode", "disable");

      await expect(
        writeRecordsGraphjinConfig({
          configFile: join(directory, "dev.yml"),
          config: {
            orgId: "org-a",
            roles: projectRecordsGraphjinRoles(model),
            database: { connectionString: connection.toString() },
            jwt: { secret: LIVE_JWT_SECRET },
            secretKey: "live-cursor-secret-that-is-at-least-thirty-two-bytes",
          },
          validate: async ({ configDirectory }) =>
            validateWithTestGraphjin(configDirectory),
          reloadRecordsGraphjin: async () => {},
        }),
      ).resolves.toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    },
    40_000,
  );

  itIfGraphjinImage(
    "enforces owner reads, fallback denial, and worker-only mutations live",
    async () => {
      const model = await loadRecordsGraphjinPolicyModel(testPool, "org-a");
      const directory = await mkdtemp(join(tmpdir(), "records-graphjin-rbac-"));
      const poolConfig = buildRecordsPoolConfig(process.env, { database });
      const connection = new URL("postgres://localhost/records");
      connection.hostname = process.env.RECORDS_GRAPHJIN_DB_HOST ?? "host.internal";
      connection.port = String(poolConfig.port);
      connection.username = String(poolConfig.user);
      connection.password = String(poolConfig.password ?? "");
      connection.pathname = `/${database}`;
      connection.searchParams.set("sslmode", "disable");
      await writeRecordsGraphjinConfig({
        configFile: join(directory, "dev.yml"),
        config: {
          orgId: "org-a",
          roles: projectRecordsGraphjinRoles(model),
          database: { connectionString: connection.toString() },
          jwt: { secret: LIVE_JWT_SECRET },
          secretKey: "live-cursor-secret-that-is-at-least-thirty-two-bytes",
        },
        validate: async ({ configDirectory }) =>
          validateWithTestGraphjin(configDirectory),
        reloadRecordsGraphjin: async () => {},
      });

      const started = await runTestCommand("docker", [
        "run",
        "--detach",
        "--rm",
        "--entrypoint",
        "graphjin",
        "--publish",
        "127.0.0.1::8090",
        "--volume",
        `${directory}:/config:ro`,
        graphjinImage!,
        "serve",
        "--path",
        "/config",
      ]);
      const containerId = started.stdout.trim();
      try {
        const portOutput = await runTestCommand("docker", [
          "port",
          containerId,
          "8090/tcp",
        ]);
        const port = Number.parseInt(portOutput.stdout.trim().split(":").at(-1) ?? "", 10);
        expect(port).toBeGreaterThan(0);
        const endpoint = `http://127.0.0.1:${port}/api/v1/graphql`;

        let healthy = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) {
              healthy = true;
              break;
            }
          } catch {
            // Container is still starting.
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!healthy) {
          const logs = await runTestCommand("docker", ["logs", containerId]);
          throw new Error(`records GraphJin did not become healthy: ${logs.stderr}`);
        }

        const request = async (
          userId: string,
          query: string,
          variables: Record<string, unknown> = {},
        ) => {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${graphjinJwt(userId)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ query, variables }),
          });
          return (await response.json()) as {
            data?: Record<string, unknown>;
            errors?: unknown[];
          };
        };

        const member = await request(
          "member-1",
          "query MemberLoans { equipment__loan(order_by: { id: asc }) { id name } }",
        );
        expect(member.errors).toBeUndefined();
        expect(member.data?.equipment__loan).toEqual([
          { id: "loan-1", name: "Member One Loan" },
        ]);

        const admin = await request(
          "admin-1",
          "query AdminLoans { equipment__loan(order_by: { id: asc }) { id name } }",
        );
        expect(admin.errors).toBeUndefined();
        expect(admin.data?.equipment__loan).toEqual([
          { id: "loan-1", name: "Member One Loan" },
          { id: "loan-2", name: "Member Two Loan" },
        ]);

        const registry = await new RecordRegistry(testPool).loadApp("org-a", "equipment");
        expect(registry).not.toBeNull();
        const generated = buildRecordListQuery({
          snapshot: registry!,
          objectApiName: "loan",
          role: "admin",
          userId: "admin-1",
          first: 1,
          search: "Loan",
        });
        const generatedPage = await request(
          "admin-1",
          generated.query,
          generated.variables,
        );
        expect(generatedPage.errors).toBeUndefined();
        expect(generatedPage.data?.rows).toEqual([
          {
            id: "loan-1",
            name: "Member One Loan",
            owner_user_id: "member-1",
          },
        ]);
        expect(generatedPage.data?.[generated.cursorField]).toEqual(expect.any(String));
        expect(generatedPage.data?.totals).toEqual([{ count_id: 2 }]);

        const missingActor = await request(
          "missing-actor",
          "query MissingActorLoans { equipment__loan { id name } }",
        );
        expect(missingActor.data?.equipment__loan ?? []).toEqual([]);
        expect(JSON.stringify(missingActor)).not.toContain("Member One Loan");
        expect(JSON.stringify(missingActor)).not.toContain("Member Two Loan");

        const memberMutation = await request(
          "member-1",
          "mutation MemberCreateLoan { equipment__loan(insert: $data) { id } }",
          { data: { id: "loan-member-blocked", name: "Blocked" } },
        );
        expect(memberMutation.errors?.length).toBeGreaterThan(0);
        const blockedMemberWrite = await testPool.query<{ count: string }>(
          "select count(*) from public.equipment__loan where id = 'loan-member-blocked'",
        );
        expect(blockedMemberWrite.rows).toEqual([{ count: "0" }]);

        const serviceMutation = await request(
          "service-1",
          "mutation ServiceCreateLoan { equipment__loan(insert: $data) { id name } }",
          {
            data: {
              id: "loan-service",
              name: "Service Created",
              owner_user_id: "member-1",
            },
          },
        );
        expect(serviceMutation.errors).toBeUndefined();
        expect(serviceMutation.data?.equipment__loan).toEqual([
          {
            id: "loan-service",
            name: "Service Created",
          },
        ]);
        const inserted = await testPool.query<{ org_id: string }>(
          "select org_id from public.equipment__loan where id = 'loan-service'",
        );
        expect(inserted.rows).toEqual([{ org_id: "org-a" }]);

        await request(
          "service-1",
          "mutation ServiceCannotChooseOrg { equipment__loan(insert: $data) { id } }",
          {
            data: {
              id: "loan-service-forced-org",
              name: "Attempted Cross-org Write",
              org_id: "org-b",
              owner_user_id: "member-1",
            },
          },
        );
        const crossOrgRows = await testPool.query<{ org_id: string }>(
          "select org_id from public.equipment__loan where org_id <> 'org-a'",
        );
        expect(crossOrgRows.rows).toEqual([]);
      } finally {
        await runTestCommand("docker", ["rm", "--force", containerId]).catch(
          () => undefined,
        );
      }
    },
    40_000,
  );
});
