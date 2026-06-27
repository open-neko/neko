import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool, reconnectPool, writeLocalConfig } from "../src";

describe("metadata DB pool config", () => {
  let tempHome: string;
  const ORIGINAL_HOME = process.env.HOME;
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "neko-poolcfg-test-"));
    process.env.HOME = tempHome;
    delete process.env.XDG_CONFIG_HOME;
    await reconnectPool();
  });

  afterEach(async () => {
    await reconnectPool();
    if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("reuses the pool while config is unchanged", () => {
    const first = pool();
    expect(pool()).toBe(first);
  });

  it("rebuilds the pool when local Postgres config changes", () => {
    const first = pool();
    writeLocalConfig({ pg: { password: "changed-password" } });
    const second = pool();

    expect(second).not.toBe(first);
    expect(pool()).toBe(second);
  });
});
