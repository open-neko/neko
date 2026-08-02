import { lstat, realpath, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ensureOrgWorkspace } from "@neko/llm/work";
import { normalizeRecordImportSourcePath } from "@neko/records";

const SALESFORCE_STAGING = /^imports\/salesforce\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RecordsStagingCleanup =
  | { status: "deleted"; completed_at: string }
  | { status: "skipped"; reason: string };

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Deletes only the worker-owned directory produced by a connected Salesforce
 * export. Human uploads and arbitrary import paths are deliberately retained.
 */
export async function cleanupSalesforceArtifactStaging(
  input: { orgId: string; artifactPath: string },
  dependencies: {
    workspaceForOrg?: typeof ensureOrgWorkspace;
    now?: () => Date;
  } = {},
): Promise<RecordsStagingCleanup> {
  const artifactPath = normalizeRecordImportSourcePath(input.artifactPath);
  if (!SALESFORCE_STAGING.test(artifactPath)) {
    return { status: "skipped", reason: "not_connected_salesforce_staging" };
  }
  const workspace = await (dependencies.workspaceForOrg ?? ensureOrgWorkspace)(
    input.orgId,
  );
  const root = await realpath(workspace.orgRoot);
  const target = resolve(root, artifactPath);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error("Salesforce staging path escapes its organization workspace");
  }
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (missing(error)) {
      return {
        status: "deleted",
        completed_at: (dependencies.now ?? (() => new Date()))().toISOString(),
      };
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Salesforce staging target is not a regular directory");
  }
  const actual = await realpath(target);
  if (actual !== target || !actual.startsWith(`${root}${sep}`)) {
    throw new Error("Salesforce staging target resolves outside its organization workspace");
  }
  await rm(target, { recursive: true, force: false });
  return {
    status: "deleted",
    completed_at: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
}
