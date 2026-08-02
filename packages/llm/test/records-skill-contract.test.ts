import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillsRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "builtin-skills",
);

async function skill(name: string): Promise<string> {
  return readFile(join(skillsRoot, name, "SKILL.md"), "utf8");
}

describe("records agent skill contracts", () => {
  it("grounds app creation in a loaded blueprint but keeps it adaptable", async () => {
    const body = await skill("app-builder");
    expect(body).toContain("mcp__neko_records__browse_blueprints");
    expect(body).toContain("Never invent a blueprint payload");
    expect(body).toContain("blueprints are starting priors");
    expect(body).toContain("one card");
  });

  it("requires exact ID resolution, disambiguation, and optimistic concurrency", async () => {
    const body = await skill("records");
    expect(body).toContain("Never guess a record ID");
    expect(body).toContain("Multiple matches");
    expect(body).toContain("expected");
    expect(body).toContain("scope: internal");
  });

  it("keeps Salesforce semantics in the CRM pack rather than engine code", async () => {
    const body = await skill("crm");
    expect(body).toContain('blueprint: "crm"');
    expect(body).toContain("owner_user_id");
    expect(body).toContain("15-character");
    expect(body).toContain("two Salesforce instances");
    expect(body).toContain("Never silently coerce an unknown value");
  });

  it("keeps Zendesk semantics and ambiguous-ticket handling in the support pack", async () => {
    const body = await skill("support-desk");
    expect(body).toContain('blueprint: "support"');
    expect(body).toContain("requester-visible replies");
    expect(body).toContain("connector instance plus source ID");
    expect(body).toContain("never choose the first similar subject");
  });
});
