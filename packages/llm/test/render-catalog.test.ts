import { describe, expect, it } from "vitest";
import {
  RENDER_CARDS_DESCRIPTION,
  RENDER_CARDS_INPUT_SCHEMA,
} from "../src/work/render-catalog";

describe("render_cards catalog", () => {
  it("advertises the v1.0 envelope and interactive form primitives", () => {
    expect(RENDER_CARDS_DESCRIPTION).toContain("A2UI v1.0");
    expect(RENDER_CARDS_DESCRIPTION).toContain("urn:openneko:catalog:work:v2");
    expect(RENDER_CARDS_DESCRIPTION).toContain("TextField");
    expect(RENDER_CARDS_DESCRIPTION).toContain("ChoicePicker");
    expect(RENDER_CARDS_DESCRIPTION).toContain("Conditional");
    expect(RENDER_CARDS_DESCRIPTION).toContain("Button");
    expect(RENDER_CARDS_DESCRIPTION).toContain('values\":{\"path\":\"/form\"}');
    expect(RENDER_CARDS_DESCRIPTION).toContain(
      '"label":"Files","value":"file"',
    );
    expect(RENDER_CARDS_DESCRIPTION).toContain("OpenApiSpecInput");
    expect(RENDER_CARDS_DESCRIPTION).toContain("ManagedFileSourceInput");
    expect(RENDER_CARDS_DESCRIPTION).toContain("/form/openApiSpec/id");
    expect(RENDER_CARDS_DESCRIPTION).toContain("Storage backend");
    expect(RENDER_CARDS_DESCRIPTION).toContain("/form/localFiles/sourceName");
  });

  it("gives the model a strict v1 component schema", () => {
    const schema = JSON.stringify(RENDER_CARDS_INPUT_SCHEMA);
    expect(schema).toContain('"const":"v1.0"');
    expect(schema).toContain('"required":["id","component"]');
    expect(schema).toContain("urn:openneko:catalog:work:v2");
  });

  it("keeps configuration submission on the proposal path", () => {
    expect(RENDER_CARDS_DESCRIPTION).toContain("proposal tool");
    expect(RENDER_CARDS_DESCRIPTION).toContain("approval policy");
    expect(RENDER_CARDS_DESCRIPTION).toContain("secretRef");
  });
});
