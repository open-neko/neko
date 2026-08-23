import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearProvider,
  createTestOrg,
  dbReachable,
  deleteTestOrg,
  seedProvider,
  uniqueOrgId,
} from "@neko/db/test-helpers";
import { pool } from "@neko/db";
import {
  resolveAgentBackend,
  resolveAgentBackendId,
  resolveAgentConcurrency,
} from "../src/agent-backend-resolver";
import { AGENT_DEFAULT_GLOBAL_CAP } from "../src/agent-backend";

const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn(
    "[agent-backend-resolver] skipping: metadata Postgres unreachable.",
  );
}

describeIfDb("Hermes-only agent resolution", () => {
  let orgId: string;

  beforeAll(async () => {
    orgId = uniqueOrgId("resolver");
    await createTestOrg(orgId);
  });

  afterEach(async () => {
    await clearProvider(orgId, "agent");
  });

  afterAll(async () => {
    await deleteTestOrg(orgId);
    await pool().end();
  });

  it("always resolves the Hermes runtime", async () => {
    expect(await resolveAgentBackendId(orgId)).toBe("hermes");
    expect((await resolveAgentBackend(orgId)).id).toBe("hermes");
  });

  it("ignores unrelated values in a stale agent row", async () => {
    await seedProvider(orgId, {
      scope: "agent",
      provider: "obsolete-runtime",
      config: { backend: "obsolete-runtime", globalCap: 30 },
    });
    expect(await resolveAgentBackendId(orgId)).toBe("hermes");
    expect((await resolveAgentBackend(orgId)).id).toBe("hermes");
    expect((await resolveAgentConcurrency(orgId)).globalCap).toBe(30);
  });

  it("uses the default concurrency without a row", async () => {
    expect((await resolveAgentConcurrency(orgId)).globalCap).toBe(
      AGENT_DEFAULT_GLOBAL_CAP,
    );
  });

  it("falls back when stored concurrency is malformed", async () => {
    await seedProvider(orgId, {
      scope: "agent",
      provider: "hermes",
      config: { globalCap: "not-a-number" },
    });
    expect((await resolveAgentConcurrency(orgId)).globalCap).toBe(
      AGENT_DEFAULT_GLOBAL_CAP,
    );
  });
});
