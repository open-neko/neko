import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const adminSource = resolve(
  here,
  "../src/app/admin/settings/packs/MagentoPackAdmin.tsx",
);

describe("Magento pack administration copy", () => {
  it("uses approval and automation outcomes instead of numeric risk labels", async () => {
    const source = await readFile(adminSource, "utf8");

    expect(source).not.toMatch(/\bclass\s*[012]\b/i);
    expect(source).toContain("Administrator approval required");
    expect(source).toContain("Can run automatically within limits");
    expect(source).toContain("Allow automatic actions within limits");
    expect(source).toContain("Actions OpenNeko will not perform");
  });

  it("uses shared controls and typography for Magento settings", async () => {
    const source = await readFile(adminSource, "utf8");

    expect(source).toContain('from "@/components/ui/Checkbox"');
    expect(source).toContain("<Checkbox");
    expect(source).not.toMatch(/<input[\s\S]{0,120}type="checkbox"/);
    expect(source).toContain("font-display text-ui-body font-bold capitalize text-text");
  });
});
