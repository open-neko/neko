import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureGraphjinGuard, isGraphjinCommandSafe } from "../src/work/graphjin-guard";

describe("isGraphjinCommandSafe", () => {
  it("allows read-style graphjin queries", () => {
    expect(
      isGraphjinCommandSafe([
        "cli",
        "execute_graphql",
        "--args",
        '{"query":"query Revenue { revenue { total } }"}',
      ]),
    ).toBe(true);
  });

  it("allows targeted relationship discovery tools", () => {
    expect(
      isGraphjinCommandSafe([
        "cli",
        "find_path",
        "--args",
        '{"from_table":"salesorderheader","to_table":"product"}',
      ]),
    ).toBe(true);
    expect(
      isGraphjinCommandSafe([
        "cli",
        "explore_relationships",
        "--args",
        '{"table":"salesorderheader"}',
      ]),
    ).toBe(true);
  });

  it("blocks mutations", () => {
    expect(
      isGraphjinCommandSafe([
        "cli",
        "execute_graphql",
        "--args",
        '{"query":"mutation Dangerous { delete_user(id: 1) }"}',
      ]),
    ).toBe(false);
  });

  it("blocks the documented write subcommands", () => {
    for (const sub of [
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
    ]) {
      expect(isGraphjinCommandSafe(["cli", sub, "--args", "{}"])).toBe(false);
    }
  });

  it("blocks ANY non-`cli` first argument (serve, migrate, admin, …)", () => {
    expect(isGraphjinCommandSafe(["serve"])).toBe(false);
    expect(isGraphjinCommandSafe(["migrate"])).toBe(false);
    expect(isGraphjinCommandSafe(["admin"])).toBe(false);
    expect(isGraphjinCommandSafe([])).toBe(false);
  });

  it("does NOT false-positive on identifiers inside read queries", () => {
    expect(
      isGraphjinCommandSafe([
        "cli",
        "execute_graphql",
        "--args",
        '{"query":"{ products(order_by: { newest: desc }) { config_value preserve_id } }"}',
      ]),
    ).toBe(true);
  });

  it("GJ5: a policy grant opens exactly the granted write subcommand", () => {
    const grants = { allowSubcommands: ["write_query"] };
    expect(isGraphjinCommandSafe(["cli", "write_query", "--args", "{}"], grants)).toBe(true);
    expect(isGraphjinCommandSafe(["cli", "write_mutation", "--args", "{}"], grants)).toBe(false);
    expect(isGraphjinCommandSafe(["cli", "setup", "http://x"], grants)).toBe(false);
    // Unknown grant names are ignored, not honored.
    expect(
      isGraphjinCommandSafe(["cli", "setup", "http://x"], { allowSubcommands: ["serve", "rm -rf"] }),
    ).toBe(false);
    // Mutations in executor payloads stay blocked even with grants.
    expect(
      isGraphjinCommandSafe(
        ["cli", "execute_graphql", "--args", '{"query":"mutation X { y }"}'],
        grants,
      ),
    ).toBe(false);
  });

  it("blocks every customer GraphJin command in records mode", () => {
    expect(
      isGraphjinCommandSafe(
        ["cli", "execute_graphql", "--args", '{"query":"{ activity { id } }"}'],
        { denyAll: true },
      ),
    ).toBe(false);
  });
});

describe("ensureGraphjinGuard wrapper script", () => {
  let dir: string;
  let wrapper: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-guard-"));
    wrapper = await ensureGraphjinGuard(dir, "/bin/echo");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is syntactically valid bash", () => {
    const r = spawnSync("bash", ["-n", wrapper], { encoding: "utf8" });
    expect(r.status, `bash -n stderr: ${r.stderr}`).toBe(0);
  });

  it("installs an explicit records-mode deny wrapper", async () => {
    const guardDir = await mkdtemp(join(tmpdir(), "neko-guard-records-"));
    try {
      const deniedWrapper = await ensureGraphjinGuard(guardDir, "/bin/echo", {
        denyAll: true,
      });
      const result = spawnSync(
        deniedWrapper,
        ["cli", "execute_graphql", "--args", '{"query":"{ activity { id } }"}'],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("records-scoped turn");
      expect(result.stdout).not.toContain("execute_graphql");
    } finally {
      await rm(guardDir, { recursive: true, force: true });
    }
  });

  it("blocks raw GraphJin HTTP probes through curl and bounds other curl calls", async () => {
    const guardDir = await mkdtemp(join(tmpdir(), "neko-guard-http-"));
    const fakeDir = await mkdtemp(join(tmpdir(), "neko-fake-curl-"));
    const prevPath = process.env.PATH;
    try {
      const fakeCurl = join(fakeDir, "curl");
      await writeFile(
        fakeCurl,
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\n",
        { encoding: "utf8", mode: 0o755 },
      );
      process.env.PATH = `${fakeDir}:${prevPath ?? ""}`;
      await ensureGraphjinGuard(guardDir, "/bin/echo");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }

    try {
      const curlWrapper = join(guardDir, "curl");
      const syntax = spawnSync("bash", ["-n", curlWrapper], { encoding: "utf8" });
      expect(syntax.status, `bash -n stderr: ${syntax.stderr}`).toBe(0);

      const blocked = spawnSync(
        curlWrapper,
        ["-i", "http://localhost:8080/api/v1/mcp"],
        { encoding: "utf8" },
      );
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain("blocks raw HTTP access to GraphJin");

      const bounded = spawnSync(curlWrapper, ["http://example.test"], {
        encoding: "utf8",
      });
      expect(bounded.status).toBe(0);
      expect(bounded.stdout.trim().split("\n")).toEqual([
        "--max-time",
        "20",
        "http://example.test",
      ]);

      const explicitTimeout = spawnSync(
        curlWrapper,
        ["--max-time", "3", "http://example.test"],
        { encoding: "utf8" },
      );
      expect(explicitTimeout.status).toBe(0);
      expect(explicitTimeout.stdout.trim().split("\n")).toEqual([
        "--max-time",
        "3",
        "http://example.test",
      ]);
    } finally {
      await rm(guardDir, { recursive: true, force: true });
      await rm(fakeDir, { recursive: true, force: true });
    }
  });

  it("execs the underlying binary for read queries", () => {
    const r = spawnSync(wrapper, [
      "cli",
      "execute_graphql",
      "--args",
      '{"query":"{ revenue { total } }"}',
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("execute_graphql");
  });

  it("execs targeted relationship discovery tools", () => {
    const findPath = spawnSync(wrapper, [
      "cli",
      "find_path",
      "--args",
      '{"from_table":"salesorderheader","to_table":"product"}',
    ], { encoding: "utf8" });
    expect(findPath.status).toBe(0);
    expect(findPath.stdout).toContain("find_path");

    const explore = spawnSync(wrapper, [
      "cli",
      "explore_relationships",
      "--args",
      '{"table":"salesorderheader"}',
    ], { encoding: "utf8" });
    expect(explore.status).toBe(0);
    expect(explore.stdout).toContain("explore_relationships");
  });

  it("blocks mutations in --args payloads (substring match)", () => {
    const r = spawnSync(wrapper, [
      "cli",
      "execute_graphql",
      "--args",
      '{"query":"mutation Bad { delete_user(id: 1) }"}',
    ], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("blocks GraphJin mutations");
  });

  it("blocks `save_workflow` under cli", () => {
    const r = spawnSync(wrapper, ["cli", "save_workflow", "--args", "{}"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("blocks GraphJin write");
  });

  it("blocks setup/config commands that can poison the shared CLI server", () => {
    for (const argv of [
      ["cli", "setup", "http://localhost:8080"],
      ["cli", "config", "show"],
      ["cli", "write_query", "--args", "{}"],
    ]) {
      const r = spawnSync(wrapper, argv, { encoding: "utf8" });
      expect(r.status, `argv=${JSON.stringify(argv)} should be denied`).toBe(2);
      expect(r.stderr).toContain("blocks GraphJin write");
    }
  });

  it("blocks `serve` outright — it is the server, the agent never invokes it", () => {
    const r = spawnSync(wrapper, ["serve"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("only 'graphjin cli");
  });

  it("blocks bare invocations and any non-`cli` first argument", () => {
    for (const argv of [[], ["migrate"], ["admin"], ["config"], ["new"]]) {
      const r = spawnSync(wrapper, argv, { encoding: "utf8" });
      expect(r.status, `argv=${JSON.stringify(argv)} should be denied`).toBe(2);
    }
  });

  it("does NOT false-positive on column names like `newest`/`config_value`/`preserve_id`", () => {
    const r = spawnSync(wrapper, [
      "cli",
      "execute_graphql",
      "--args",
      '{"query":"{ products(order_by: { newest: desc }) { config_value preserve_id } }"}',
    ], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("GJ5: a granted wrapper passes the grant through and still blocks the rest", async () => {
    const grantBin = join(dir, "grant-bin");
    await mkdir(grantBin, { recursive: true });
    const granted = await ensureGraphjinGuard(grantBin, "/bin/echo", {
      allowSubcommands: ["write_query"],
    });
    expect(spawnSync("bash", ["-n", granted], { encoding: "utf8" }).status).toBe(0);
    const ok = spawnSync(granted, ["cli", "write_query", "--args", "{}"], {
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("write_query");
    const denied = spawnSync(granted, ["cli", "setup", "http://x"], {
      encoding: "utf8",
    });
    expect(denied.status).toBe(2);
    const mutation = spawnSync(
      granted,
      ["cli", "execute_graphql", "--args", '{"query":"mutation Bad { x }"}'],
      { encoding: "utf8" },
    );
    expect(mutation.status).toBe(2);
  });

  it("pins XDG_CONFIG_HOME and HOME for the wrapped graphjin process", async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const pinned = join(dir, "pinned-config");
    process.env.XDG_CONFIG_HOME = pinned;
    const fake = join(dir, "fake-graphjin");
    const pinnedBin = join(dir, "pinned-bin");
    await mkdir(pinnedBin);
    await writeFile(fake, "#!/usr/bin/env bash\necho \"$XDG_CONFIG_HOME|$HOME\"\n", {
      encoding: "utf8",
      mode: 0o755,
    });
    const pinnedWrapper = await ensureGraphjinGuard(pinnedBin, fake);
    const r = spawnSync(
      pinnedWrapper,
      ["cli", "health"],
      {
        encoding: "utf8",
        env: { ...process.env, XDG_CONFIG_HOME: join(dir, "agent-override") },
      },
    );
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${pinned}|${pinned}`);
  });

  it("injects the per-run GraphJin actor token as an Authorization header", async () => {
    const pinned = join(dir, "token-config");
    const cfgDir = join(pinned, "graphjin");
    const fake = join(dir, "fake-graphjin-token");
    const pinnedBin = join(dir, "token-bin");
    await mkdir(cfgDir, { recursive: true });
    await mkdir(pinnedBin, { recursive: true });
    await writeFile(
      join(cfgDir, "client.json"),
      JSON.stringify({
        server: "http://localhost:8080/api/v1/mcp",
        token: "actor-token",
      }),
    );
    await writeFile(fake, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\n", {
      encoding: "utf8",
      mode: 0o755,
    });
    const pinnedWrapper = await ensureGraphjinGuard(pinnedBin, fake, {
      xdgConfigHome: pinned,
    });

    const r = spawnSync(
      pinnedWrapper,
      ["cli", "execute_graphql", "--args", '{"query":"{ x }"}'],
      { encoding: "utf8" },
    );

    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      "cli",
      "--header",
      "Authorization: Bearer actor-token",
      "execute_graphql",
      "--args",
      '{"query":"{ x }"}',
    ]);
  });
});

describe("ensureGraphjinGuard output compaction", () => {
  let dir: string;
  let wrapper: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "neko-guard-compact-"));
    // A fake graphjin that ignores its args and prints a large uniform row set.
    const fakeBin = join(dir, "fake-graphjin");
    await writeFile(
      fakeBin,
      [
        "#!/usr/bin/env node",
        'const rows = Array.from({ length: 100 }, (_, i) => ({ productid: i + 1, locationid: (i % 3) * 5 + 1, shelf: ["A","B","C"][i % 3], bin: i % 30, quantity: 100 + i, modifieddate: "2025-08-08T00:00:00" }));',
        'process.stdout.write(JSON.stringify({ data: { productinventory: rows } }));',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    wrapper = await ensureGraphjinGuard(dir, fakeBin);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const query = ["cli", "execute_graphql", "--args", '{"query":"{ productinventory { productid } }"}'];

  it("compacts a large row set to a columnar table by default", () => {
    const r = spawnSync(wrapper, query, { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__neko_cols__");
    // Same data: the columnar form re-expands to the original rows.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.data.productinventory.__neko_cols__.rows.length).toBe(100);
  });

  it("passes raw JSON through when OPENNEKO_GRAPHJIN_COMPACT=0", () => {
    const r = spawnSync(wrapper, query, {
      encoding: "utf8",
      env: { ...process.env, OPENNEKO_GRAPHJIN_COMPACT: "0" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("__neko_cols__");
    expect(JSON.parse(r.stdout).data.productinventory).toHaveLength(100);
  });
});
