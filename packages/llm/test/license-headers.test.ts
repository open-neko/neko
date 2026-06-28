import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMERCIAL = "SPDX-License-Identifier: LicenseRef-OpenNeko-Commercial";

// Files whose contents are wholly an enterprise feature (OpenNeko Commercial License).
const ENTERPRISE = ["src/workflows/audit-chain.ts", "src/work/behavior-monitor.ts"];

// Foundation files that must stay Apache-licensed core code.
const FOUNDATION = [
  "src/work/authz.ts",
  "src/work/memory.ts",
  "src/graphjin/token.ts",
];

describe("license boundary", () => {
  it.each(ENTERPRISE)("%s carries the commercial SPDX header", (rel) => {
    expect(readFileSync(join(pkgRoot, rel), "utf8")).toContain(COMMERCIAL);
  });

  it.each(FOUNDATION)("%s is not marked commercial", (rel) => {
    expect(readFileSync(join(pkgRoot, rel), "utf8")).not.toContain(COMMERCIAL);
  });
});
