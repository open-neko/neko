import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRecordsManagedStaging } from "../../src/records/staging-hygiene.js";

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
      cleanupRecordsManagedStaging(
        { orgId: "org-a", sourcePath: `imports/salesforce/${EXPORT_ID}` },
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
      cleanupRecordsManagedStaging(
        { orgId: "org-a", sourcePath: `imports/salesforce/${EXPORT_ID}` },
        { workspaceForOrg: async () => ({ orgRoot: root }) as never },
      ),
    ).rejects.toThrow("not a regular directory");
    await expect(readFile(join(outside, "keep.csv"), "utf8")).resolves.toBe("keep");
  });

  it("retains human uploads and non-export import paths", async () => {
    await expect(
      cleanupRecordsManagedStaging(
        { orgId: "org-a", sourcePath: "uploads/customer.csv" },
        {
          workspaceForOrg: async () => {
            throw new Error("workspace must not be opened");
          },
        },
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "not_worker_managed_staging",
    });
  });

  it("deletes the whole random CLI stage after a successful source import", async () => {
    const root = await temporaryRoot();
    const stageId = "00000000000000000000000000000001";
    const target = join(root, "imports", "cli", stageId);
    await mkdir(join(target, "sf-export", "data"), { recursive: true });
    await writeFile(join(target, "sf-export", "data", "account.csv"), "Id,Name\n001,Acme\n");

    await expect(
      cleanupRecordsManagedStaging(
        {
          orgId: "org-a",
          sourcePath: `imports/cli/${stageId}/sf-export`,
        },
        {
          workspaceForOrg: async () => ({ orgRoot: root }) as never,
          now: () => new Date("2026-08-02T12:00:00.000Z"),
        },
      ),
    ).resolves.toEqual({
      status: "deleted",
      completed_at: "2026-08-02T12:00:00.000Z",
    });
    await expect(readFile(join(target, "sf-export", "data", "account.csv"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
