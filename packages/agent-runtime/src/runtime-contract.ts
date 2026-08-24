import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_RUNTIME_MANIFEST = "agent-runtime-manifest.json";

export interface AgentRuntimeManifest {
  schemaVersion: 1;
  packageVersion: string;
  roles: {
    agentEntry: string;
    mcpBridge: string;
    builtinSkills: string;
    graphjinCompactCli: string;
  };
  runtimeDefaults: Record<string, string>;
  files: Array<{ path: string; sha256: string }>;
}

export interface AgentRuntimeContract {
  root: string;
  manifestPath: string;
  manifest: AgentRuntimeManifest;
  agentEntryPath: string;
  mcpBridgePath: string;
  builtinSkillsRoot: string;
  graphjinCompactCliPath: string;
}

interface ConfigureAgentRuntimeOptions {
  entryUrl?: string;
  env?: NodeJS.ProcessEnv;
  pathExists?: (candidate: string) => boolean;
  readText?: (candidate: string) => string;
}

function validateRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value)) {
    throw new Error(`agent runtime manifest has invalid ${label}`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) {
    throw new Error(`agent runtime manifest has unsafe ${label}: ${value}`);
  }
  return normalized;
}

export function readAgentRuntimeManifest(
  manifestPath: string,
  readText: (candidate: string) => string = (candidate) =>
    readFileSync(candidate, "utf8"),
): AgentRuntimeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(manifestPath));
  } catch (error) {
    throw new Error(
      `agent runtime contract invalid: cannot read ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const manifest = parsed as Partial<AgentRuntimeManifest>;
  if (manifest.schemaVersion !== 1) {
    throw new Error("agent runtime contract invalid: unsupported manifest schema");
  }
  if (
    typeof manifest.packageVersion !== "string" ||
    !manifest.packageVersion.trim() ||
    !manifest.roles ||
    !manifest.runtimeDefaults ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("agent runtime contract invalid: incomplete manifest");
  }
  for (const role of [
    "agentEntry",
    "mcpBridge",
    "builtinSkills",
    "graphjinCompactCli",
  ] as const) {
    validateRelativePath(manifest.roles[role], `role ${role}`);
  }
  for (const [name, value] of Object.entries(manifest.runtimeDefaults)) {
    if (!name.trim() || typeof value !== "string") {
      throw new Error(`agent runtime manifest has invalid default ${name}`);
    }
  }
  for (const file of manifest.files) {
    validateRelativePath(file?.path, "file path");
    if (!/^[a-f0-9]{64}$/.test(file?.sha256 ?? "")) {
      throw new Error(`agent runtime manifest has invalid checksum for ${file?.path}`);
    }
  }
  return manifest as AgentRuntimeManifest;
}

export function configureAgentRuntime(
  options: ConfigureAgentRuntimeOptions = {},
): AgentRuntimeContract {
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? existsSync;
  const root = dirname(fileURLToPath(options.entryUrl ?? import.meta.url));
  const manifestPath = join(root, AGENT_RUNTIME_MANIFEST);
  const manifest = readAgentRuntimeManifest(manifestPath, options.readText);
  const rolePath = (path: string) =>
    resolve(root, validateRelativePath(path, "role"));
  const contract = {
    root,
    manifestPath,
    manifest,
    agentEntryPath: rolePath(manifest.roles.agentEntry),
    mcpBridgePath: rolePath(manifest.roles.mcpBridge),
    builtinSkillsRoot: rolePath(manifest.roles.builtinSkills),
    graphjinCompactCliPath: rolePath(manifest.roles.graphjinCompactCli),
  };
  for (const [role, candidate] of Object.entries({
    agentEntry: contract.agentEntryPath,
    mcpBridge: contract.mcpBridgePath,
    builtinSkills: contract.builtinSkillsRoot,
    graphjinCompactCli: contract.graphjinCompactCliPath,
  })) {
    if (!pathExists(candidate)) {
      throw new Error(`agent runtime contract invalid: ${role} not found at ${candidate}`);
    }
  }
  for (const [name, value] of Object.entries(manifest.runtimeDefaults)) {
    env[name] = value;
  }
  env.OPENNEKO_MCP_BRIDGE = contract.mcpBridgePath;
  env.OPENNEKO_BUILTIN_SKILLS_ROOT = contract.builtinSkillsRoot;
  env.OPENNEKO_GRAPHJIN_COMPACT_CLI = contract.graphjinCompactCliPath;
  return contract;
}

export async function verifyAgentRuntime(
  contract: AgentRuntimeContract,
): Promise<void> {
  const expected = new Map(
    contract.manifest.files.map((file) => [file.path, file.sha256]),
  );
  if (expected.size !== contract.manifest.files.length) {
    throw new Error("agent runtime contract invalid: duplicate manifest paths");
  }
  const actualFiles = (await walkFiles(contract.root))
    .map((absolutePath) =>
      relative(contract.root, absolutePath).split(sep).join("/"),
    )
    .filter((path) => path !== AGENT_RUNTIME_MANIFEST)
    .sort();
  const expectedFiles = [...expected.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    const missing = expectedFiles.filter((path) => !actualFiles.includes(path));
    const undeclared = actualFiles.filter((path) => !expected.has(path));
    throw new Error(
      `agent runtime contract invalid: artifact file set differs` +
        `${missing.length ? `; missing=${missing.join(",")}` : ""}` +
        `${undeclared.length ? `; undeclared=${undeclared.join(",")}` : ""}`,
    );
  }
  for (const [path, checksum] of expected) {
    const contents = await readFile(join(contract.root, path));
    const actual = createHash("sha256").update(contents).digest("hex");
    if (actual !== checksum) {
      throw new Error(`agent runtime contract invalid: checksum mismatch for ${path}`);
    }
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolutePath)));
    else if (entry.isFile()) files.push(absolutePath);
    else {
      throw new Error(
        `agent runtime contract invalid: unsupported entry ${absolutePath}`,
      );
    }
  }
  return files;
}
