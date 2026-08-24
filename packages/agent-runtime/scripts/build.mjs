import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const distRoot = join(packageRoot, "dist");
const manifestName = "agent-runtime-manifest.json";
const forbiddenInput = /packages\/(db|records|secret-crypt|telemetry)\/|node_modules\/\.pnpm\/(pg-boss|pg@|mysql2|onnxruntime|sharp)/;

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });

const common = {
  absWorkingDir: repoRoot,
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  metafile: true,
};

const builds = await Promise.all([
  build({
    ...common,
    entryPoints: [join(packageRoot, "src", "entry.ts")],
    outfile: join(distRoot, "agent-entry.js"),
  }),
  build({
    ...common,
    entryPoints: [join(packageRoot, "src", "mcp-bridge.ts")],
    outfile: join(distRoot, "mcp-bridge.js"),
  }),
]);

for (const result of builds) {
  const forbidden = Object.keys(result.metafile?.inputs ?? {}).filter((input) =>
    forbiddenInput.test(input.replaceAll("\\", "/")),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `agent runtime contains forbidden control-plane dependencies:\n${forbidden.join("\n")}`,
    );
  }
}

await cp(join(repoRoot, "packages", "llm", "assets"), join(distRoot, "assets"), {
  recursive: true,
});
await mkdir(join(distRoot, "tool-output"), { recursive: true });
await cp(
  join(repoRoot, "packages", "llm", "src", "work", "tool-output", "compact-cli.mjs"),
  join(distRoot, "tool-output", "compact-cli.mjs"),
);

const packageJson = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
const files = [];
for (const absolutePath of await walkFiles(distRoot)) {
  const path = relative(distRoot, absolutePath).split(sep).join("/");
  if (path === manifestName) continue;
  const contents = await readFile(absolutePath);
  files.push({
    path,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
}
files.sort((left, right) => left.path.localeCompare(right.path));

const manifest = {
  schemaVersion: 1,
  packageVersion: packageJson.version,
  roles: {
    agentEntry: "agent-entry.js",
    mcpBridge: "mcp-bridge.js",
    builtinSkills: "assets/builtin-skills",
    graphjinCompactCli: "tool-output/compact-cli.mjs",
  },
  runtimeDefaults: {
    HERMES_DISABLE_LAZY_INSTALLS: "1",
  },
  files,
};
await writeFile(
  join(distRoot, manifestName),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

async function walkFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
    else throw new Error(`agent runtime artifact cannot contain ${entry.name}`);
  }
  return files;
}
