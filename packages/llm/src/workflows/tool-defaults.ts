// Historical prompt/tool catalog constants retained for eval compatibility.
export const WORKFLOW_BUILDER_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "mcp__neko_workflow_builder__create_workflow",
  "mcp__neko_workflow_builder__list_workflows",
] as const;

export const WORKFLOW_RUNNER_DEFAULT_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "AskUserQuestion",
  "Agent",
  "Skill",
  "mcp__neko_ui__render_cards",
  "mcp__neko_memory__search",
  "mcp__neko_memory__save",
  "mcp__neko_library__search",
  "mcp__neko_workflow_output__emit",
  "mcp__neko_action__request",
] as const;
