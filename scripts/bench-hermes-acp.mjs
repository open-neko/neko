#!/usr/bin/env node

import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const fixturePath = resolve(scriptDir, "fixtures/hermes-bench-mcp.mjs");
const skillsDir = resolve(repoRoot, "packages/llm/assets/builtin-skills");

function parseArgs(argv) {
  const opts = {
    baseline: process.env.HERMES_BENCH_BASELINE || "",
    candidate: process.env.HERMES_BENCH_CANDIDATE || "",
    samples: 5,
    mcpCounts: [0, 1, 3, 10],
    groupCandidateMcp: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline") opts.baseline = argv[++i] || "";
    else if (arg === "--candidate") opts.candidate = argv[++i] || "";
    else if (arg === "--samples") opts.samples = Number(argv[++i]);
    else if (arg === "--mcp-counts") {
      opts.mcpCounts = (argv[++i] || "").split(",").map(Number);
    } else if (arg === "--json") opts.json = true;
    else if (arg === "--group-candidate-mcp") opts.groupCandidateMcp = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/bench-hermes-acp.mjs --baseline PATH --candidate PATH " +
          "[--samples 5] [--mcp-counts 0,1,3,10] [--group-candidate-mcp] [--json]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.baseline || !opts.candidate) {
    throw new Error("--baseline and --candidate Hermes binary paths are required");
  }
  if (!Number.isInteger(opts.samples) || opts.samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  if (opts.mcpCounts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error("--mcp-counts must contain non-negative integers");
  }
  return opts;
}

function percentile(values, pct) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function summarize(values) {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function formatMs(value) {
  return `${value.toFixed(0)}ms`;
}

function psTreeRssKb(rootPid) {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows = output
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length === 3 && row.every(Number.isFinite));
    const pids = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of rows) {
        if (pids.has(ppid) && !pids.has(pid)) {
          pids.add(pid);
          changed = true;
        }
      }
    }
    return rows.reduce((sum, [pid, , rss]) => sum + (pids.has(pid) ? rss : 0), 0);
  } catch {
    return 0;
  }
}

async function makeHermesHome(label, root) {
  const home = resolve(root, label);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(home, "config.yaml"),
    [
      "model:",
      '  default: "gemini-3.6-flash"',
      '  provider: "gemini"',
      "agent:",
      "  max_turns: 2",
      "delegation:",
      "  orchestrator_enabled: false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await symlink(skillsDir, resolve(home, "skills"), "dir");
  return home;
}

function runVersion(binary, env) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = performance.now();
    execFile(binary, ["--version"], { env, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${binary} --version failed: ${stderr || error.message}`));
        return;
      }
      resolvePromise({
        durationMs: performance.now() - startedAt,
        version: stdout.split("\n")[0]?.trim() || "unknown",
      });
    });
  });
}

async function terminate(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("close", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

async function runAcpSample(binary, env, cwd, mcpCount, groupMcp = false) {
  const startedAt = performance.now();
  const child = spawn(binary, ["--yolo", "acp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const stderr = [];
  let nextId = 1;
  let peakTreeRssKb = 0;
  const rssTimer = setInterval(() => {
    peakTreeRssKb = Math.max(peakTreeRssKb, psTreeRssKb(child.pid));
  }, 25);
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const failPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on("error", failPending);
  child.on("close", (code, signal) => {
    if (pending.size === 0) return;
    const tail = Buffer.concat(stderr).toString("utf8").slice(-2_000);
    failPending(new Error(`Hermes exited code=${code} signal=${signal}: ${tail}`));
  });

  rl.on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame?.method === "string" && typeof frame?.id === "number") {
      const options = Array.isArray(frame.params?.options) ? frame.params.options : [];
      const allow = options.find((option) => option.kind === "allow_once") || options[0];
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            outcome: allow?.optionId
              ? { outcome: "selected", optionId: allow.optionId }
              : { outcome: "cancelled" },
          },
        })}\n`,
      );
      return;
    }
    if (typeof frame?.id !== "number") return;
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)));
    else waiter.resolve(frame.result);
  });

  const request = (method, params) =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolvePromise, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const timeout = setTimeout(() => {
    failPending(new Error(`ACP benchmark timed out after 120s (${mcpCount} MCP servers)`));
  }, 120_000);

  try {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const initializedAt = performance.now();
    const serverIds = Array.from({ length: mcpCount }, (_, index) => String(index));
    const mcpServers = groupMcp && mcpCount > 0
      ? [{
          name: "neko",
          command: process.execPath,
          args: [fixturePath, ...serverIds],
          env: [],
        }]
      : serverIds.map((serverId) => ({
          name: `bench_${serverId}`,
          command: process.execPath,
          args: [fixturePath, serverId],
          env: [],
        }));
    await request("session/new", { cwd, mcpServers });
    const sessionReadyAt = performance.now();
    peakTreeRssKb = Math.max(peakTreeRssKb, psTreeRssKb(child.pid));
    return {
      initializeMs: initializedAt - startedAt,
      sessionNewMs: sessionReadyAt - initializedAt,
      totalMs: sessionReadyAt - startedAt,
      peakTreeRssMb: peakTreeRssKb / 1024,
    };
  } finally {
    clearTimeout(timeout);
    clearInterval(rssTimer);
    rl.close();
    failPending(new Error("benchmark sample finished"));
    await terminate(child);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(resolve(tmpdir(), "openneko-hermes-bench-"));
  const variants = [
    { label: "v0.14", binary: resolve(opts.baseline), groupMcp: false },
    {
      label: opts.groupCandidateMcp ? "v0.20+multiplexer" : "v0.20",
      binary: resolve(opts.candidate),
      groupMcp: opts.groupCandidateMcp,
    },
  ];
  const results = Object.fromEntries(
    variants.map((variant) => [variant.label, { version: "", versionMs: [], acp: {} }]),
  );

  try {
    for (const variant of variants) {
      variant.home = await makeHermesHome(variant.label.replace(".", "_"), tempRoot);
      variant.cwd = resolve(tempRoot, `${variant.label.replace(".", "_")}_cwd`);
      await mkdir(variant.cwd, { recursive: true });
      variant.env = {
        ...process.env,
        HERMES_HOME: variant.home,
        HERMES_YOLO_MODE: "1",
        PYTHONFAULTHANDLER: "1",
      };
      const warmVersion = await runVersion(variant.binary, variant.env);
      results[variant.label].version = warmVersion.version;
    }

    for (let sample = 0; sample < opts.samples; sample += 1) {
      for (const variant of variants) {
        const measured = await runVersion(variant.binary, variant.env);
        results[variant.label].versionMs.push(measured.durationMs);
      }
    }

    for (const mcpCount of opts.mcpCounts) {
      for (const variant of variants) {
        await runAcpSample(
          variant.binary,
          variant.env,
          variant.cwd,
          mcpCount,
          variant.groupMcp,
        );
        results[variant.label].acp[mcpCount] = [];
      }
      for (let sample = 0; sample < opts.samples; sample += 1) {
        for (const variant of variants) {
          const measured = await runAcpSample(
            variant.binary,
            variant.env,
            variant.cwd,
            mcpCount,
            variant.groupMcp,
          );
          results[variant.label].acp[mcpCount].push(measured);
        }
      }
    }

    const summary = {};
    for (const variant of variants) {
      const raw = results[variant.label];
      summary[variant.label] = {
        version: raw.version,
        versionMs: summarize(raw.versionMs),
        acp: {},
      };
      for (const [count, samples] of Object.entries(raw.acp)) {
        summary[variant.label].acp[count] = {
          initializeMs: summarize(samples.map((sample) => sample.initializeMs)),
          sessionNewMs: summarize(samples.map((sample) => sample.sessionNewMs)),
          totalMs: summarize(samples.map((sample) => sample.totalMs)),
          peakTreeRssMb: summarize(samples.map((sample) => sample.peakTreeRssMb)),
        };
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log("\nHermes ACP A/B (warmup discarded; lower is better)");
    if (opts.groupCandidateMcp) {
      console.log("Candidate multiplexes logical MCP servers through one child process.");
    }
    console.log(`Samples per cell: ${opts.samples}`);
    for (const variant of variants) {
      const row = summary[variant.label];
      console.log(`\n${variant.label}: ${row.version}`);
      console.log(
        `  --version: p50 ${formatMs(row.versionMs.p50)}, p95 ${formatMs(row.versionMs.p95)}`,
      );
      for (const count of opts.mcpCounts) {
        const acp = row.acp[count];
        console.log(
          `  MCP=${count}: initialize p50 ${formatMs(acp.initializeMs.p50)}, ` +
            `session/new p50 ${formatMs(acp.sessionNewMs.p50)}, ` +
            `total p50 ${formatMs(acp.totalMs.p50)} / p95 ${formatMs(acp.totalMs.p95)}, ` +
            `peak tree RSS p50 ${acp.peakTreeRssMb.p50.toFixed(0)}MB`,
        );
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
