import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSalesforceArtifactStaging } from "../../src/records/staging-hygiene.js";

const EXPORT_ID = "00000000-0000-4000-a000-000000000922";
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openneko-staging-hygiene-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("connected staging hygiene", () => {
  it("deletes a completed Salesforce export directory", async () => {
    const root = await temporaryRoot();
    const target = join(root, "imports", "salesforce", EXPORT_ID);
    await mkdir(join(target, "data"), { recursive: true });
    await writeFile(join(target, "data", "account.csv"), "Id,Name\n001,Acme\n");

    await expect(
      cleanupSalesforceArtifactStaging(
        { orgId: "org-a", artifactPath: `imports/salesforce/${EXPORT_ID}` },
        {
          workspaceForOrg: async () => ({ orgRoot: root }) as never,
          now: () => new Date("2026-08-02T12:00:00.000Z"),
        },
      ),
    ).resolves.toEqual({
      status: "deleted",
      completed_at: "2026-08-02T12:00:00.000Z",
    });
    await expect(readFile(join(target, "data", "account.csv"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not follow a Salesforce-shaped symlink outside the workspace", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(join(root, "imports", "salesforce"), { recursive: true });
    await writeFile(join(outside, "keep.csv"), "keep");
    await symlink(outside, join(root, "imports", "salesforce", EXPORT_ID));

    await expect(
      cleanupSalesforceArtifactStaging(
        { orgId: "org-a", artifactPath: `imports/salesforce/${EXPORT_ID}` },
        { workspaceForOrg: async () => ({ orgRoot: root }) as never },
      ),
    ).rejects.toThrow("not a regular directory");
    await expect(readFile(join(outside, "keep.csv"), "utf8")).resolves.toBe("keep");
  });

  it("retains human uploads and non-export import paths", async () => {
    await expect(
      cleanupSalesforceArtifactStaging(
        { orgId: "org-a", artifactPath: "uploads/customer.csv" },
        {
          workspaceForOrg: async () => {
            throw new Error("workspace must not be opened");
          },
        },
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "not_connected_salesforce_staging",
    });
  });
});
