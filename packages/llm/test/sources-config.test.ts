import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SOURCES_SECRET_PLACEHOLDER,
  atomicWriteFile,
  migrateGraphjinSystemSource,
  patchGraphjinSourcesJwtSecret,
  shouldReconcileDemoSourceAuthMode,
} from "../src/graphjin/sources-config";
import * as hostProvision from "../src/host-provision";

const SOURCES_CONFIG = `# sources mode
auth:
  type: jwt
  jwt:
    # per-org actor-token secret
    secret: "${SOURCES_SECRET_PLACEHOLDER}"
`;

describe("patchGraphjinSourcesJwtSecret", () => {
  it("replaces the placeholder", () => {
    const patched = patchGraphjinSourcesJwtSecret(SOURCES_CONFIG, "s3cret==");
    expect(patched.changed).toBe(true);
    expect(patched.content).toContain('secret: "s3cret=="');
    expect(patched.content).not.toContain(SOURCES_SECRET_PLACEHOLDER);
  });

  it("repairs a stale concrete secret", () => {
    const seeded = patchGraphjinSourcesJwtSecret(SOURCES_CONFIG, "old==").content;
    const repaired = patchGraphjinSourcesJwtSecret(seeded, "new==");
    expect(repaired.changed).toBe(true);
    expect(repaired.content).toContain('secret: "new=="');
  });

  it("is a no-op when the secret is already current", () => {
    const seeded = patchGraphjinSourcesJwtSecret(SOURCES_CONFIG, "same==").content;
    const again = patchGraphjinSourcesJwtSecret(seeded, "same==");
    expect(again.changed).toBe(false);
    expect(again.content).toBe(seeded);
  });

  it("leaves configs without a jwt auth block untouched", () => {
    const anonymous = "auth:\n  type: none\n";
    const patched = patchGraphjinSourcesJwtSecret(anonymous, "s==");
    expect(patched.changed).toBe(false);
    expect(patched.content).toBe(anonymous);
  });
});

describe("migrateGraphjinSystemSource", () => {
  it("moves the removed graphjin pseudo-source to top-level system config", () => {
    const legacy = `mode: agentic
sources:
  - name: graphjin
    kind: graphjin
    capabilities:
      config.write: true
    access:
      roots:
        gj_catalog: authenticated
        gj_config: admin
  - name: adventureworks
    kind: database
    default: true
`;

    const migrated = migrateGraphjinSystemSource(legacy);

    expect(migrated.changed).toBe(true);
    expect(migrated.content).not.toContain("kind: graphjin");
    expect(migrated.content).toContain("name: adventureworks");
    expect(migrated.content).toContain("system:");
    expect(migrated.content).toContain("catalog.read: true");
    expect(migrated.content).toContain("config.write: true");
    expect(migrated.content).toContain("gj_catalog: authenticated");
    expect(migrated.content).toContain("gj_config: admin");
  });

  it("preserves explicit system restrictions while filling missing defaults", () => {
    const legacy = `mode: agentic
system:
  capabilities:
    config.write: false
  root_access:
    gj_catalog: admin
sources:
  - name: graphjin
    kind: graphjin
`;

    const migrated = migrateGraphjinSystemSource(legacy);

    expect(migrated.content).toContain("config.write: false");
    expect(migrated.content).toContain("gj_catalog: admin");
    expect(migrated.content).toContain("runtime.read: true");
    expect(migrated.content).toContain("gj_runtime: admin");
  });

  it("leaves an already-current config byte-for-byte unchanged", () => {
    const current = `mode: agentic
system:
  capabilities:
    catalog.read: true
sources:
  - name: app
    kind: database
`;

    expect(migrateGraphjinSystemSource(current)).toEqual({
      content: current,
      changed: false,
    });
  });
});

describe("shouldReconcileDemoSourceAuthMode", () => {
  const jwtConfig = patchGraphjinSourcesJwtSecret(SOURCES_CONFIG, "k==").content;

  it("recognises demo stack mode with a jwt template", () => {
    expect(shouldReconcileDemoSourceAuthMode("/any/path.yml", jwtConfig, "demo")).toBe(true);
  });

  it("recognises the legacy packaged demo mount", () => {
    expect(
      shouldReconcileDemoSourceAuthMode("/graphjin-config/agentic.yml", jwtConfig, undefined),
    ).toBe(true);
  });

  it("stays off for prod paths and anonymous configs", () => {
    expect(
      shouldReconcileDemoSourceAuthMode("/config/graphjin/agentic.yml", jwtConfig, undefined),
    ).toBe(false);
    expect(shouldReconcileDemoSourceAuthMode("/x.yml", "auth:\n  type: none\n", "demo")).toBe(
      false,
    );
  });
});

describe("atomicWriteFile", () => {
  it("replaces content without leaving a temp file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sources-config-"));
    const target = join(dir, "agentic.yml");
    await writeFile(target, "before", "utf8");

    await atomicWriteFile(target, "after");

    expect(await readFile(target, "utf8")).toBe("after");
    expect(await readdir(dir)).toEqual(["agentic.yml"]);
  });

  it("honours an explicit mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sources-config-"));
    const target = join(dir, ".env");
    await atomicWriteFile(target, "KEY=v\n", { mode: 0o600 });
    const info = await stat(target);
    expect(info.mode & 0o777).toBe(0o600);
  });
});

// host-provision must keep re-exporting the canonical implementations —
// the graphjin-secret-init one-shot and the worker's boot pass patch the
// same file and must agree byte-for-byte.
describe("host-provision re-exports", () => {
  it("exposes the same functions as sources-config", () => {
    expect(hostProvision.patchGraphjinSourcesJwtSecret).toBe(patchGraphjinSourcesJwtSecret);
    expect(hostProvision.migrateGraphjinSystemSource).toBe(migrateGraphjinSystemSource);
    expect(hostProvision.shouldReconcileDemoSourceAuthMode).toBe(
      shouldReconcileDemoSourceAuthMode,
    );
    expect(hostProvision.SOURCES_SECRET_PLACEHOLDER).toBe(SOURCES_SECRET_PLACEHOLDER);
  });
});
