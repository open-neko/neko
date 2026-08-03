import { describe, expect, it } from "vitest";
import { buildRecordNavSections, type RecordNavObject } from "@/lib/record-nav";

function objects(count: number): RecordNavObject[] {
  return Array.from({ length: count }, (_, index) => ({
    apiName: `object_${index + 1}`,
    label: `Object ${index + 1}`,
    pluralLabel: index === 149 ? "Service appointments" : `Objects ${index + 1}`,
    recordCount: String(index),
    custom: index % 2 === 0,
  }));
}

describe("record app navigation", () => {
  it("keeps favorites and the active recent object visible while collapsing a large catalog", () => {
    const result = buildRecordNavSections({
      objects: objects(250),
      favorites: ["object_200", "object_2", "object_200"],
      recents: ["object_40", "object_200"],
      activeObjectApiName: "object_175",
    });

    expect(result.sections.map((section) => section.id)).toEqual([
      "favorites",
      "recent",
      "browse",
    ]);
    expect(result.sections[0]?.objects.map((object) => object.apiName)).toEqual([
      "object_200",
      "object_2",
    ]);
    expect(result.sections[1]?.objects[0]?.apiName).toBe("object_175");
    expect(result.sections[2]?.objects).toHaveLength(12);
    expect(result.hiddenCount).toBe(234);
  });

  it("searches labels and API names across collapsed objects", () => {
    const result = buildRecordNavSections({
      objects: objects(250),
      favorites: [],
      recents: [],
      query: "service app",
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.objects[0]?.apiName).toBe("object_150");

    const apiResult = buildRecordNavSections({
      objects: objects(250),
      favorites: [],
      recents: [],
      query: "object_249",
    });
    expect(apiResult.sections[0]?.objects[0]?.apiName).toBe("object_249");
  });
});
