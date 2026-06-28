import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OLD_COMMERCIAL_MARKER = "LicenseRef-" + "OpenNeko-Commercial";

const FILES = [
  "src/infisical-resolver.ts",
  "src/secrets-resolver.ts",
  "src/secrets-store.ts",
];

describe("license headers", () => {
  it.each(FILES)("%s is not marked with the old commercial license reference", (rel) => {
    expect(readFileSync(join(pkgRoot, rel), "utf8")).not.toContain(OLD_COMMERCIAL_MARKER);
  });
});
