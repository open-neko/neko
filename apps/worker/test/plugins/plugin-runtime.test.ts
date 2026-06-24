// Runtime-agnostic plugin-runtime contract (SEC9): the network-mode
// translation and the exec-command builder every runtime shares.

import { describe, expect, it } from "vitest";
import {
  buildEnvFile,
  buildExecCommand,
  networkModeFor,
} from "../../src/plugins/plugin-runtime.js";

describe("networkModeFor", () => {
  it("returns 'none' for empty host list", () => {
    expect(networkModeFor([])).toBe("none");
  });

  it("returns 'public' for any declared host", () => {
    expect(networkModeFor(["api.example.com"])).toBe("public");
    expect(networkModeFor(["a.b.c", "*.example.org"])).toBe("public");
  });
});

describe("buildEnvFile", () => {
  it("emits POSIX-sourceable export lines", () => {
    expect(buildEnvFile({ SLACK_BOT_TOKEN: "xoxb-abc", RUN_ID: "r-1" })).toBe(
      "export SLACK_BOT_TOKEN='xoxb-abc'\nexport RUN_ID='r-1'",
    );
  });

  it("POSIX-escapes single quotes inside values", () => {
    expect(buildEnvFile({ FOO: "it's ok" })).toBe(`export FOO='it'\\''s ok'`);
  });

  it("rejects bad env key names that could be shell-substring attacks", () => {
    expect(() => buildEnvFile({ "FOO; rm -rf /": "x" })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => buildEnvFile({ lowercase: "x" })).toThrow(/UPPER_SNAKE_CASE/);
  });
});

describe("buildExecCommand", () => {
  it("without an env file, returns plain node exec (fast path)", () => {
    expect(buildExecCommand("register", "{}")).toEqual({
      cmd: "node",
      args: ["/workspace/run.js", "register", "{}"],
    });
  });

  it("honors a custom runner path", () => {
    expect(buildExecCommand("m", "{}", { runnerPath: "/sandbox/run.js" })).toEqual({
      cmd: "node",
      args: ["/sandbox/run.js", "m", "{}"],
    });
  });

  it("with an env file, sources it then exec node — and carries NO secret value", () => {
    const out = buildExecCommand("execute_action", '{"x":1}', {
      envFilePath: "/sandbox/.plugin-env",
      runnerPath: "/sandbox/run.js",
    });
    expect(out.cmd).toBe("sh");
    expect(out.args[0]).toBe("-c");
    expect(out.args[1]).toBe(
      `. '/sandbox/.plugin-env'; exec node /sandbox/run.js 'execute_action' '{"x":1}'`,
    );
  });
});
