import { describe, expect, it } from "vitest";
import type { AgentWorkspace } from "../src/agent-backend";
import type { KnowledgePackContents } from "../src/knowledge-pack";
import { buildWorkPrompt } from "../src/work/prompt";

const workspace: AgentWorkspace = {
  orgRoot: "/tmp/org",
  skillsRoot: "/tmp/org/skills",
  memoryRoot: "/tmp/org/memory",
  knowledgeRoot: "/tmp/org/knowledge",
  uploadsRoot: "/tmp/org/uploads",
  runsRoot: "/tmp/org/runs",
  threadUploadsRoot: "/tmp/org/uploads/t1",
  runRoot: "/tmp/org/runs/r1",
  artifactRoot: "/tmp/org/runs/r1/artifacts",
  binRoot: "/tmp/org/runs/r1/bin",
  claudeProjectRoot: "/tmp/org",
  claudeConfigRoot: "/tmp/org/claude/config",
};

const knowledge: KnowledgePackContents = {
  tables: "{}",
  namespaces: "{}",
  insights: "{}",
  syntax: "{}",
};

function build(
  backend: "claude-agent" | "hermes",
  overrides: {
    wantsCards?: boolean;
    supportsCardTool?: boolean;
    supportsSkillTool?: boolean;
    supportsMemoryTool?: boolean;
    supportsWorkflowTool?: boolean;
    supportsPolicyTool?: boolean;
    supportsSourceConfigTool?: boolean;
    installedSkills?: Array<{ name: string; description: string }>;
  } = {},
): string {
  return buildWorkPrompt({
    backend,
    workspace,
    knowledge,
    messages: [],
    currentUserMessage: "test",
    wantsCards: overrides.wantsCards ?? true,
    supportsCardTool: overrides.supportsCardTool ?? false,
    supportsSkillTool: overrides.supportsSkillTool ?? false,
    supportsMemoryTool: overrides.supportsMemoryTool ?? false,
    supportsWorkflowTool: overrides.supportsWorkflowTool ?? false,
    supportsPolicyTool: overrides.supportsPolicyTool ?? false,
    supportsSourceConfigTool: overrides.supportsSourceConfigTool ?? false,
    installedSkills: overrides.installedSkills,
    inlineTranscript: false,
  });
}

describe("buildWorkPrompt attachments guidance", () => {
  it("tells the claude-agent how to read uploads and which path shape to expect", () => {
    const prompt = build("claude-agent");
    expect(prompt).toContain("<attachments>");
    expect(prompt).toContain("uploads/<threadId>/<filename>");
    expect(prompt).toContain("`Read` tool");
    // Path is relative to cwd, which is orgRoot.
    expect(prompt).toContain(workspace.orgRoot);
  });

  it("references the hermes shell tool when running under hermes", () => {
    const prompt = build("hermes");
    expect(prompt).toContain("<attachments>");
    // Hermes' shell tool is `terminal`, claude-agent's is `Bash`. The
    // attachments block names whichever one is wired up so the agent picks
    // the right tool for non-text formats.
    expect(prompt).toContain("`terminal`");
  });

  it("no longer dismisses uploaded files as 'auxiliary'", () => {
    const prompt = build("claude-agent");
    // The old wording told the model uploaded files were auxiliary, which it
    // routinely took as permission to ignore them. The new framing must
    // explicitly say to read them.
    expect(prompt).not.toMatch(/Uploaded files are auxiliary/);
    expect(prompt).toMatch(/read the file/i);
  });
});

describe("buildWorkPrompt skill catalog", () => {
  it("includes compact discovery metadata and a path for on-demand instructions", () => {
    const prompt = build("hermes", {
      installedSkills: [
        { name: "pdf", description: "Read, create, and inspect PDF files." },
      ],
    });

    expect(prompt).toContain("pdf — Read, create, and inspect PDF files.");
    expect(prompt).toContain(`${workspace.skillsRoot}/pdf/SKILL.md`);
    expect(prompt).toContain("When a skill matches, read its SKILL.md");
    expect(prompt).not.toContain("Full PDF skill body");
  });
});

describe("per-channel rendering gate", () => {
  it("renders via the render_cards tool on web turns (wantsCards)", () => {
    // claude → the neko_ui MCP tool; hermes → its stdio render server tool.
    const claudeWeb = build("claude-agent", { wantsCards: true, supportsCardTool: true });
    expect(claudeWeb).toContain("<rendering>");
    expect(claudeWeb).toContain("mcp__neko_ui__render_cards");
    expect(claudeWeb).toContain("interface that fits the current request");
    expect(claudeWeb).not.toContain("BriefingCard");

    const hermesWeb = build("hermes", { wantsCards: true, supportsCardTool: false });
    expect(hermesWeb).toContain("<rendering>");
    expect(hermesWeb).toContain("render_cards");
    // The web-UI-coupled fence is gone from the prompt entirely.
    expect(hermesWeb).not.toContain("neko_a2ui");
  });

  it("omits all rendering vocabulary on non-web turns", () => {
    for (const backend of ["claude-agent", "hermes"] as const) {
      const prompt = build(backend, { wantsCards: false, supportsCardTool: backend === "claude-agent" });
      expect(prompt).not.toContain("<rendering>");
      expect(prompt).not.toContain("neko_a2ui");
      expect(prompt).not.toContain("render_cards");
    }
  });
});

describe("buildWorkPrompt workflow + policy management", () => {
  it("advertises workflow tools when supportsWorkflowTool is true", () => {
    const prompt = build("claude-agent", { supportsWorkflowTool: true });
    expect(prompt).toContain("mcp__neko_workflow_builder__list_workflows");
    expect(prompt).toContain("mcp__neko_workflow_builder__create_workflow");
    // Operators are not developers — should warn against showing cron syntax.
    expect(prompt).toMatch(/never show them cron syntax/i);
  });

  it("falls back to the workflow save fence when MCP tools unavailable", () => {
    const prompt = build("hermes", { supportsWorkflowTool: false });
    expect(prompt).toContain("neko_workflow_save");
    expect(prompt).not.toContain("mcp__neko_workflow_builder__");
  });

  it("teaches the data-change trigger in both workflow tool modes", () => {
    const mcp = build("claude-agent", { supportsWorkflowTool: true });
    expect(mcp).toContain("triggers.when");
    expect(mcp).not.toContain("create_subscription");
    expect(mcp).not.toContain("dry_run");

    const fence = build("hermes", { supportsWorkflowTool: false });
    expect(fence).toContain("triggers.when");
    // The trigger must not surface as a separate "subscription" tool/fence.
    expect(fence).not.toContain("neko_subscription");
    expect(fence).not.toContain("create_subscription");
  });

  it("advertises rule tools when supportsPolicyTool is true", () => {
    const prompt = build("claude-agent", { supportsPolicyTool: true });
    expect(prompt).toContain("mcp__neko_rule_builder__list_rules");
    expect(prompt).toContain("mcp__neko_rule_builder__save_rule");
  });

  it("falls back to the rule save fence when MCP tools unavailable", () => {
    const prompt = build("hermes", { supportsPolicyTool: false });
    expect(prompt).toContain("neko_rule_save");
    expect(prompt).not.toContain("mcp__neko_rule_builder__");
  });

  it("advertises GraphJin source-config tools only when enabled", () => {
    const enabled = build("claude-agent", { supportsSourceConfigTool: true });
    expect(enabled).toContain("graphjin-config");
    expect(enabled).toContain(`${workspace.skillsRoot}/graphjin-config/SKILL.md`);
    expect(enabled).toContain("mcp__neko_source_config_manager__describe_source_graph");
    expect(enabled).toContain("Call `ask_graphjin_config_agent`");
    expect(enabled).toContain("Success for a view or explanation");
    expect(enabled).toContain("source_config_admin");
    expect(enabled).toContain("Database, API,\nand Files");
    expect(enabled).toContain("Conditional groups");
    expect(enabled).toContain("OpenAPI specs directory");
    expect(enabled).toContain("local root or object-store bucket");
    expect(enabled).not.toContain("trusted host");
    expect(enabled).not.toContain("globally read-only");
    expect(enabled).not.toContain("outside the sandbox");

    const disabled = build("claude-agent", { supportsSourceConfigTool: false });
    expect(disabled).not.toContain("mcp__neko_source_config_manager__");
  });

  it("frames /work as the single chat surface for everything", () => {
    const prompt = build("claude-agent");
    expect(prompt).toMatch(/only chat surface/i);
  });
});

describe("buildWorkPrompt native delegation guidance", () => {
  it("teaches Hermes to use delegate_task without OpenNeko-named profiles", () => {
    const prompt = build("hermes");
    expect(prompt).toContain("<delegation>");
    expect(prompt).toContain("delegate_task");
    expect(prompt).toContain("OpenNeko does not provide named subagent profiles");
    expect(prompt).not.toContain("researcher");
    expect(prompt).not.toContain("coder");
  });

  it("teaches Claude dynamic Agent delegation without programmatic profiles", () => {
    const prompt = build("claude-agent");
    expect(prompt).toContain("<delegation>");
    expect(prompt).toContain("Agent");
    expect(prompt).toContain("general-purpose");
    expect(prompt).toContain("filesystem-discovered agents");
    expect(prompt).toMatch(/OpenNeko does\s+not define named subagent\s+profiles/);
  });
});
