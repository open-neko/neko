import { and, data_source_secret, db, eq } from "@neko/db";
import { maybeDecryptSecret } from "@neko/llm/secrets";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import {
  SalesforceApiClient,
  SalesforceApiGovernor,
  SalesforceConnector,
  SalesforceSchemaApprovalStaleError,
  recordIdentifier,
  verifySalesforceSchemaReview,
  type RecordConnectorMode,
  type SalesforceSchemaReview,
} from "@neko/records";

export type SalesforceActionConfig = {
  sourceInstanceId: string;
  instanceUrl: string;
  clientId: string;
  clientSecretRef: string;
  apiVersion: string;
  dailyApiLimit: number;
  mode: RecordConnectorMode;
  app: string;
  label: string;
  objects: string[] | undefined;
};

export class SalesforceActionConfigError extends Error {
  readonly code = "records_salesforce_config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SalesforceActionConfigError";
  }
}

function requiredString(payload: Record<string, unknown>, field: string, max = 500): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new SalesforceActionConfigError(`${field}: a non-empty string is required`);
  }
  return value.trim();
}

function optionalInteger(
  payload: Record<string, unknown>,
  field: string,
  fallback: number,
  maximum: number,
): number {
  const value = payload[field];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new SalesforceActionConfigError(
      `${field}: an integer between 1 and ${maximum} is required`,
    );
  }
  return Number(value);
}

function objectNames(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 500 ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        /^[A-Za-z][A-Za-z0-9_]*$/.test(item) &&
        item.length <= 255,
    )
  ) {
    throw new SalesforceActionConfigError(
      "objects: 1 to 500 Salesforce API names are required",
    );
  }
  if (new Set(value).size !== value.length) {
    throw new SalesforceActionConfigError("objects: duplicate API names are not allowed");
  }
  return [...value].sort();
}

export function parseSalesforceActionConfig(
  payload: Record<string, unknown>,
): SalesforceActionConfig {
  const mode = payload.mode ?? "mirror";
  if (mode !== "mirror" && mode !== "primary") {
    throw new SalesforceActionConfigError("mode: mirror or primary is required");
  }
  const apiVersion =
    typeof payload.api_version === "string" ? payload.api_version.trim() : "64.0";
  if (!/^\d{2,3}\.0$/.test(apiVersion)) {
    throw new SalesforceActionConfigError("api_version: a Salesforce version like 64.0 is required");
  }
  return {
    sourceInstanceId: requiredString(payload, "source_instance_id"),
    instanceUrl: requiredString(payload, "instance_url", 1_000),
    clientId: requiredString(payload, "client_id", 500),
    clientSecretRef: requiredString(payload, "client_secret_ref", 200),
    apiVersion,
    dailyApiLimit: optionalInteger(payload, "daily_api_limit", 10_000, 1_000_000),
    mode,
    app: requiredString(payload, "app", 500),
    label: requiredString(payload, "label", 500),
    objects: objectNames(payload.objects),
  };
}

/** Read the immutable, credential-free schema plan attached before approval. */
export function parseApprovedSalesforceSchemaReview(
  payload: Record<string, unknown>,
): SalesforceSchemaReview {
  const review = payload.salesforce_schema_review;
  verifySalesforceSchemaReview(review);
  const config = parseSalesforceActionConfig(payload);
  if (
    review.sourceInstanceId !== config.sourceInstanceId ||
    review.mode !== config.mode ||
    review.plan.definition.appId !== recordIdentifier(config.app) ||
    review.plan.definition.label !== config.label
  ) {
    throw new SalesforceSchemaApprovalStaleError(
      "Salesforce schema review does not match the connector configuration",
    );
  }
  if (config.objects) {
    const reviewed = review.plan.mappings
      .map((mapping) => mapping.sourceObject)
      .sort();
    if (
      reviewed.length !== config.objects.length ||
      reviewed.some((name, index) => name !== config.objects![index])
    ) {
      throw new SalesforceSchemaApprovalStaleError(
        "Salesforce object selection changed after schema review",
      );
    }
  }
  return review;
}

export async function createSalesforceConnectorForAction(
  request: ActionRequestRecord,
): Promise<SalesforceConnector> {
  const config = parseSalesforceActionConfig(request.payload);
  const rows = await db()
    .select({ valueEnc: data_source_secret.value_enc })
    .from(data_source_secret)
    .where(
      and(
        eq(data_source_secret.org_id, request.orgId),
        eq(data_source_secret.name, config.clientSecretRef),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new SalesforceActionConfigError(
      `client_secret_ref: named secret ${config.clientSecretRef} was not found`,
    );
  }
  const clientSecret = maybeDecryptSecret(rows[0].valueEnc);
  if (!clientSecret) {
    throw new SalesforceActionConfigError("client_secret_ref: named secret is empty");
  }
  const governor = new SalesforceApiGovernor(config.dailyApiLimit);
  const client = new SalesforceApiClient({
    instanceUrl: config.instanceUrl,
    clientId: config.clientId,
    clientSecret,
    apiVersion: config.apiVersion,
    governor,
  });
  return new SalesforceConnector({
    client,
    sourceInstanceId: config.sourceInstanceId,
    mode: config.mode,
    app: config.app,
    label: config.label,
    objects: config.objects,
  });
}
