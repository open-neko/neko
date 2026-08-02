import { describe, expect, it } from "vitest";
import {
  RecordAppBlueprintError,
  listRecordAppBlueprints,
  loadRecordAppBlueprint,
} from "../src/blueprints";

describe("records app blueprints", () => {
  it("ships stable, complete CRM and support definitions", async () => {
    const blueprints = await listRecordAppBlueprints();

    expect(blueprints.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: "crm", version: "1.0.0" },
      { id: "support", version: "1.0.0" },
    ]);
    for (const blueprint of blueprints) {
      expect(blueprint.schemaVersion).toBe(1);
      expect(blueprint.definition.appId).toBe(blueprint.id);
      expect(blueprint.definition.objects.length).toBeGreaterThanOrEqual(4);
      expect(blueprint.definition.pages).toHaveLength(1);

      const objectNames = new Set(
        blueprint.definition.objects.map((object) => object.apiName),
      );
      for (const object of blueprint.definition.objects) {
        expect(object.layouts.map((layout) => layout.kind).sort()).toEqual([
          "detail",
          "list",
        ]);
        for (const field of object.fields) {
          for (const target of field.referenceTargets ?? []) {
            expect(objectNames.has(target)).toBe(true);
          }
        }
        for (const role of ["admin", "member"] as const) {
          expect(
            blueprint.definition.permissions.some(
              (permission) =>
                permission.role === role &&
                permission.objectApiName === object.apiName,
            ),
          ).toBe(true);
        }
      }
    }
  });

  it("returns an approval-ready payload and normalized definition", async () => {
    const blueprint = await loadRecordAppBlueprint("crm");

    expect(blueprint.payload).toMatchObject({ app: "crm", label: "CRM" });
    expect(blueprint.definition.objects.map((object) => object.apiName)).toEqual([
      "account",
      "contact",
      "opportunity",
      "activity",
    ]);
  });

  it("rejects traversal and unknown blueprint ids", async () => {
    await expect(loadRecordAppBlueprint("../crm")).rejects.toBeInstanceOf(
      RecordAppBlueprintError,
    );
    await expect(loadRecordAppBlueprint("missing")).rejects.toThrow(
      "unknown records blueprint",
    );
  });
});
