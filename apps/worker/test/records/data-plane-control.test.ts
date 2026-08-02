import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RecordsDataPlaneController,
  RecordsDataPlaneTransitionError,
} from "../../src/records/data-plane-control.js";

describe("records GraphJin data-plane control", () => {
  it("persists stopped/ready state and proves each endpoint transition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "records-control-"));
    let alive = false;
    const fetch = vi.fn(async () => {
      if (!alive) throw new Error("connection refused");
      return new Response("ok", { status: 200 });
    });
    const controller = new RecordsDataPlaneController({
      configDirectory: directory,
      baseUrl: "http://records-graphjin:8090",
      timeoutMs: 50,
      pollMs: 1,
      fetch,
    });

    await controller.setReady(false, "schema application");
    expect(await controller.requestedState()).toBe("stopped");
    expect(await readFile(controller.controlFile, "utf8")).toContain(
      "# schema application",
    );

    alive = true;
    await controller.setReady(true, "policy projected");
    expect(await controller.requestedState()).toBe("ready");
    expect(fetch).toHaveBeenCalled();

    await controller.requestReload();
    expect(await readFile(controller.reloadFile, "utf8")).toMatch(
      /^[0-9a-f-]+\n$/,
    );
  });

  it("fails if the supervised process does not reach the requested state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "records-control-timeout-"));
    const controller = new RecordsDataPlaneController({
      configDirectory: directory,
      baseUrl: "http://records-graphjin:8090",
      timeoutMs: 2,
      pollMs: 1,
      fetch: vi.fn().mockResolvedValue(new Response("still serving")),
    });
    await expect(controller.setReady(false, "must stop")).rejects.toBeInstanceOf(
      RecordsDataPlaneTransitionError,
    );
    expect(await controller.requestedState()).toBe("stopped");
  });
});
