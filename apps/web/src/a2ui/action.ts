/** Turn an A2UI action context into the visible follow-up sent to the agent. */
export function buildActionFollowUp(context?: Record<string, unknown>): string | null {
  const prompt = typeof context?.prompt === "string" ? context.prompt.trim() : "";
  if (!prompt) return null;
  const submitted = Object.fromEntries(
    Object.entries(context ?? {}).filter(([key]) => key !== "prompt"),
  );
  if (Object.keys(submitted).length === 0) return prompt;
  return [
    prompt,
    "",
    "Submitted values:",
    "```json",
    JSON.stringify(submitted, null, 2),
    "```",
  ].join("\n");
}
