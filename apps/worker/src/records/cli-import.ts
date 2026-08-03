import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ActionExecutePayload } from "@neko/db/jobs";
import type {
  ActionRequestRecord,
  CreateActionRequestInput,
} from "@neko/llm/workflows";
import {
  normalizeRecordImportSourcePath,
  RecordRegistry,
  validateRecordIdentifier,
} from "@neko/records";
import type { RecordsImportHandlerSurface } from "../admin-server.js";

const CLI_ACTOR_BACKEND = "openneko-cli";

type CliImportDependencies = {
  orgId: string;
  workspaceForOrg: (orgId: string) => Promise<{ orgRoot: string }>;
  registry: RecordRegistry;
  createRequest: (
    input: CreateActionRequestInput,
  ) => Promise<ActionRequestRecord>;
  getRequest: (
    orgId: string,
    id: string,
  ) => Promise<ActionRequestRecord | null>;
  approveRequest: (input: {
    id: string;
    orgId: string;
    approverUserId: string | null;
    approver: { userId: null; role: "admin" };
  }) => Promise<ActionRequestRecord>;
  enqueueAction: (payload: ActionExecutePayload) => Promise<string | null>;
};

export class RecordsCliImportError extends Error {
  readonly code = "records_cli_import_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordsCliImportError";
  }
}

function requiredString(
  input: Record<string, unknown>,
  field: string,
  maximum = 2_000,
): string {
  const value = input[field];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximum
  ) {
    throw new RecordsCliImportError(
      `${field}: a non-empty string is required`,
    );
  }
  return value.trim();
}

function optionalString(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  if (input[field] === undefined || input[field] === null) return undefined;
  return requiredString(input, field);
}

function optionalInteger(
  input: Record<string, unknown>,
  field: string,
): number | undefined {
  if (input[field] === undefined) return undefined;
  if (
    !Number.isSafeInteger(input[field]) ||
    Number(input[field]) < 1 ||
    Number(input[field]) > 500
  ) {
    throw new RecordsCliImportError(
      `${field}: an integer between 1 and 500 is required`,
    );
  }
  return Number(input[field]);
}

function optionalMapping(
  input: Record<string, unknown>,
): Record<string, string | null> | undefined {
  const value = input.mapping;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecordsCliImportError("mapping: an object is required");
  }
  const mapping: Record<string, string | null> = {};
  for (const [source, target] of Object.entries(value)) {
    if (
      !source.trim() ||
      (target !== null &&
        (typeof target !== "string" || !target.trim()))
    ) {
      throw new RecordsCliImportError(
        "mapping: each source column must map to a field name or null",
      );
    }
    mapping[source] = target === null ? null : target.trim();
  }
  return mapping;
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowlist = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowlist.has(key));
  if (unknown.length > 0) {
    throw new RecordsCliImportError(
      `unknown input field${unknown.length === 1 ? "" : "s"}: ${unknown
        .sort()
        .join(", ")}`,
    );
  }
}

function cliSourcePath(value: string, mode: "file" | "artifact"): string {
  let path: string;
  try {
    path = normalizeRecordImportSourcePath(value);
  } catch (error) {
    throw new RecordsCliImportError(
      error instanceof Error ? error.message : "source path is invalid",
    );
  }
  if (!path.startsWith("imports/cli/")) {
    throw new RecordsCliImportError(
      "CLI imports must be staged below imports/cli/",
    );
  }
  if (mode === "file" && !path.toLowerCase().endsWith(".csv")) {
    throw new RecordsCliImportError("file imports require a .csv source");
  }
  if (mode === "artifact" && path.toLowerCase().endsWith(".csv")) {
    throw new RecordsCliImportError(
      "artifact imports require a directory source",
    );
  }
  return path;
}

function cliIdentifier(value: string, field: string): string {
  try {
    return validateRecordIdentifier(value);
  } catch (error) {
    throw new RecordsCliImportError(
      `${field}: ${error instanceof Error ? error.message : "invalid records API identifier"}`,
    );
  }
}

async function resolveAppForObject(
  dependencies: CliImportDependencies,
  appId: string | undefined,
  objectApiName: string,
): Promise<string> {
  const requestedObject = cliIdentifier(objectApiName, "object");
  if (appId) return cliIdentifier(appId, "app");
  const matches: string[] = [];
  for (const app of await dependencies.registry.listApps(dependencies.orgId)) {
    const snapshot = await dependencies.registry.loadApp(
      dependencies.orgId,
      app.appId,
    );
    if (
      snapshot?.objects.some(
        (object) =>
          object.apiName === requestedObject && object.archivedAt === null,
      )
    ) {
      matches.push(app.appId);
    }
  }
  if (matches.length === 0) {
    throw new RecordsCliImportError(
      `object ${requestedObject} was not found in an active app`,
    );
  }
  if (matches.length > 1) {
    throw new RecordsCliImportError(
      `object ${requestedObject} exists in multiple apps; pass --app`,
    );
  }
  return matches[0]!;
}

export function createRecordsCliImportBridge(
  dependencies: CliImportDependencies,
): RecordsImportHandlerSurface {
  return {
    async staging() {
      const workspace = await dependencies.workspaceForOrg(dependencies.orgId);
      const containerRoot = join(workspace.orgRoot, "imports", "cli");
      await mkdir(containerRoot, { recursive: true, mode: 0o700 });
      await chmod(containerRoot, 0o700);
      return { orgId: dependencies.orgId, containerRoot };
    },

    async prepare(input) {
      const mode = input.mode;
      if (mode !== "file" && mode !== "artifact") {
        throw new RecordsCliImportError("mode must be file or artifact");
      }
      const sourcePath = cliSourcePath(
        requiredString(input, "sourcePath"),
        mode,
      );
      let kind: string;
      let appId: string;
      let payload: Record<string, unknown>;
      let summary: string;
      if (mode === "file") {
        assertOnlyKeys(input, [
          "mode",
          "sourcePath",
          "app",
          "object",
          "mapping",
          "duplicateKey",
          "batchSize",
          "ownerUserId",
        ]);
        const objectApiName = cliIdentifier(
          requiredString(input, "object", 63),
          "object",
        );
        const mapping = optionalMapping(input);
        const duplicateKey = optionalString(input, "duplicateKey");
        const batchSize = optionalInteger(input, "batchSize");
        const ownerUserId = optionalString(input, "ownerUserId");
        appId = await resolveAppForObject(
          dependencies,
          optionalString(input, "app"),
          objectApiName,
        );
        kind = "records_import_start";
        payload = {
          app: appId,
          object: objectApiName,
          source_path: sourcePath,
          ...(mapping ? { mapping } : {}),
          ...(duplicateKey ? { duplicate_key: duplicateKey } : {}),
          ...(batchSize ? { batch_size: batchSize } : {}),
          ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
        };
        summary = `Import CSV into ${appId}.${objectApiName}`;
      } else {
        assertOnlyKeys(input, [
          "mode",
          "sourcePath",
          "app",
          "label",
          "purpose",
          "batchSize",
          "ownerUserId",
        ]);
        appId = cliIdentifier(requiredString(input, "app", 63), "app");
        const purpose = optionalString(input, "purpose");
        const batchSize = optionalInteger(input, "batchSize");
        const ownerUserId = optionalString(input, "ownerUserId");
        kind = "records_artifact_import_start";
        payload = {
          artifact_path: sourcePath,
          app: appId,
          label: optionalString(input, "label") ?? appId,
          ...(purpose ? { purpose } : {}),
          ...(batchSize ? { batch_size: batchSize } : {}),
          ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
        };
        summary = `Create ${appId} from a staged artifact export`;
      }

      const request = await dependencies.createRequest({
        orgId: dependencies.orgId,
        scope: "internal",
        kind,
        target:
          mode === "file"
            ? `record-import:${appId}/${String(payload.object)}`
            : `record-import:${appId}`,
        payload,
        riskLevel: "high",
        status: "pending_approval",
        summary,
        intent:
          "The operator explicitly requested this import from the host CLI and must review its immutable plan before execution.",
        actorUserId: null,
        actorRole: "admin",
        actorBackend: CLI_ACTOR_BACKEND,
      });
      return {
        request: {
          id: request.id,
          kind: request.kind,
          status: request.status,
          payload: request.payload,
        },
      };
    },

    async start(requestId) {
      let request = await dependencies.getRequest(
        dependencies.orgId,
        requestId,
      );
      if (!request || request.actorBackend !== CLI_ACTOR_BACKEND) {
        throw new RecordsCliImportError(
          "CLI import action request was not found",
        );
      }
      if (
        request.kind !== "records_import_start" &&
        request.kind !== "records_artifact_import_start"
      ) {
        throw new RecordsCliImportError(
          "action request is not a CLI records import",
        );
      }
      if (request.status === "pending_approval") {
        request = await dependencies.approveRequest({
          id: request.id,
          orgId: dependencies.orgId,
          approverUserId: null,
          approver: { userId: null, role: "admin" },
        });
      }
      if (request.status === "executed") {
        return { requestId: request.id, status: request.status, jobId: null };
      }
      if (request.status !== "approved") {
        throw new RecordsCliImportError(
          `CLI import cannot start from ${request.status}`,
        );
      }
      const jobId = await dependencies.enqueueAction({
        orgId: dependencies.orgId,
        actionRequestId: request.id,
      });
      if (!jobId) {
        throw new Error("CLI import action could not be queued");
      }
      return { requestId: request.id, status: "queued", jobId };
    },
  };
}
