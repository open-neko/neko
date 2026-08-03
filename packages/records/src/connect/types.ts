import type { JsonObject, RecordIdentifier } from "../types";

export const RECORDS_ARTIFACT_FORMAT = "openneko.records.artifact.v1" as const;

export type RecordConnectorMode = "mirror" | "primary";

export type RecordArtifactObject = {
  sourceApiName: string;
  objectApiName: RecordIdentifier;
  dataPath: string;
  describePath: string | null;
  expectedRows: number;
  sha256: string;
  watermark: JsonObject | null;
};

/** Feeder-neutral directory contract consumed by the Phase 2 importer. */
export type RecordsArtifactManifest = {
  format: typeof RECORDS_ARTIFACT_FORMAT;
  source: {
    kind: string;
    instanceId: string;
    mode: RecordConnectorMode;
  };
  generatedAt: string;
  watermark: JsonObject | null;
  objects: RecordArtifactObject[];
  manifestHash: string;
};

export type RecordConnectorObjectInventory = {
  sourceApiName: string;
  label: string;
  pluralLabel: string;
  queryable: boolean;
  replicateable: boolean;
  estimatedRows: number | null;
  fields: number;
};

export type RecordConnectorInventory = {
  connector: string;
  sourceInstanceId: string;
  mode: RecordConnectorMode;
  objects: RecordConnectorObjectInventory[];
  warnings: string[];
};

export type RecordConnectorExportResult = {
  directory: string;
  manifest: RecordsArtifactManifest;
};

export type RecordConnectorDelta = {
  sourceApiName: string;
  records: Array<Record<string, unknown>>;
  deletedIds: string[];
  nextWatermark: JsonObject;
};

/** Worker-native connectors stage artifacts; they never mutate app tables directly. */
export interface RecordsConnector {
  discover(signal?: AbortSignal): Promise<RecordConnectorInventory>;
  export(input: {
    directory: string;
    resume?: boolean;
    signal?: AbortSignal;
  }): Promise<RecordConnectorExportResult>;
  delta(input: {
    sourceApiName: string;
    watermark: JsonObject | null;
    signal?: AbortSignal;
  }): Promise<RecordConnectorDelta>;
}
