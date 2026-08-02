import { describe, expect, it } from "vitest";
import {
  parseRecordsArtifactManifest,
  RecordsArtifactManifestError,
  serializeRecordsArtifactManifest,
} from "../src/connect/artifacts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function manifest(): Record<string, unknown> {
  return {
    format: "openneko.records.artifact.v1",
    source: {
      kind: "salesforce",
      instance_id: "sf-production",
      mode: "mirror",
    },
    generated_at: "2026-08-02T10:00:00+00:00",
    watermark: { system_modstamp: "2026-08-02T09:59:59.000Z" },
    objects: [
      {
        source_api_name: "Contact",
        object_api_name: "contact",
        data_path: "data/Contact.csv",
        describe_path: "describe/Contact.json",
        expected_rows: 12,
        sha256: HASH_B,
        watermark: { system_modstamp: "2026-08-02T09:59:58.000Z" },
      },
      {
        source_api_name: "Account",
        object_api_name: "account",
        data_path: "data/Account.csv",
        describe_path: "describe/Account.json",
        expected_rows: 4,
        sha256: HASH_A,
      },
    ],
  };
}

describe("records artifact manifests", () => {
  it("normalizes the feeder-neutral contract and binds it to a stable hash", () => {
    const parsed = parseRecordsArtifactManifest(manifest());
    expect(parsed).toMatchObject({
      source: { kind: "salesforce", instanceId: "sf-production", mode: "mirror" },
      generatedAt: "2026-08-02T10:00:00.000Z",
      objects: [
        {
          sourceApiName: "Account",
          objectApiName: "account",
          dataPath: "data/Account.csv",
          expectedRows: 4,
        },
        {
          sourceApiName: "Contact",
          objectApiName: "contact",
          describePath: "describe/Contact.json",
        },
      ],
    });
    expect(parsed.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseRecordsArtifactManifest(JSON.parse(serializeRecordsArtifactManifest(parsed)))).toEqual(
      parsed,
    );

    const reversed = manifest();
    reversed.objects = [...(reversed.objects as unknown[])].reverse();
    expect(parseRecordsArtifactManifest(reversed).manifestHash).toBe(parsed.manifestHash);
  });

  it("rejects traversal, hostile target identifiers, bad hashes, and duplicate files", () => {
    for (const mutate of [
      (raw: Record<string, unknown>) => {
        (raw.objects as Array<Record<string, unknown>>)[0]!.data_path = "data/../secret.csv";
      },
      (raw: Record<string, unknown>) => {
        (raw.objects as Array<Record<string, unknown>>)[0]!.object_api_name =
          'contact") { secret }';
      },
      (raw: Record<string, unknown>) => {
        (raw.objects as Array<Record<string, unknown>>)[0]!.sha256 = "not-a-hash";
      },
      (raw: Record<string, unknown>) => {
        const objects = raw.objects as Array<Record<string, unknown>>;
        objects[1]!.data_path = objects[0]!.data_path;
      },
    ]) {
      const raw = manifest();
      mutate(raw);
      expect(() => parseRecordsArtifactManifest(raw)).toThrow(
        RecordsArtifactManifestError,
      );
    }
  });
});
