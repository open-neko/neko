// Prompt builder for the library distiller ("the librarian"): given one
// uploaded document plus the current concept catalog, the model emits
// neko_library fence ops (see fence.ts). Update-not-append is the core
// instruction — re-uploads revise existing concepts instead of creating
// duplicates, and contradictions get flagged inside the affected concept.

export type DistillPromptInput = {
  filename: string;
  /** Extracted text of the uploaded document (may be truncated). */
  content: string;
  /** Existing concept paths with titles/descriptions, for update-not-append. */
  catalog: Array<{ path: string; title: string; description?: string }>;
  truncated: boolean;
};

export const DISTILL_CONTENT_LIMIT = 60_000;

export function buildDistillPrompt(input: DistillPromptInput): string {
  const catalog =
    input.catalog.length === 0
      ? "(the library is empty)"
      : input.catalog
          .map(
            (c) =>
              `- ${c.path} — ${c.title}${c.description ? `: ${c.description}` : ""}`,
          )
          .join("\n");

  return [
    "You are the librarian for a business knowledge library. You are given",
    "one uploaded document. Decide whether it contains durable business",
    "knowledge (policies, contracts, procedures, definitions, agreements,",
    "org facts) or one-off working data, then catalog it.",
    "",
    "Rules:",
    "- Durable knowledge → emit one `upsert` per distinct topic. Write the",
    "  concept body as concise reference markdown: what the document",
    "  establishes, key numbers/dates/obligations, and anything a teammate",
    "  would need without reading the original.",
    "- One-off working data (raw tables, exports, scratch data) → emit a",
    "  single `skip` with a short reason. Do not catalog it.",
    "- UPDATE, don't duplicate: if an existing concept in the catalog below",
    "  covers the same topic, reuse its exact `path` so the concept is",
    "  revised in place. Only mint a new path for a genuinely new topic.",
    "- If this document contradicts what an existing concept says, reuse",
    "  that concept's path and note the contradiction explicitly in the",
    '  body under a "## Conflicts" heading.',
    "- Paths are lowercase slugs grouped by kind, e.g.",
    '  "policies/refund-policy.md", "contracts/acme-msa.md".',
    '- `type` is a short capitalized kind: "Policy", "Contract", "SOP",',
    '  "Report", "Notes" — choose what fits.',
    "- Do not include frontmatter in `body`; metadata travels in the op",
    "  fields. Do not invent facts not in the document.",
    "",
    "Current catalog:",
    catalog,
    "",
    `Uploaded document: ${input.filename}`,
    input.truncated
      ? "(content truncated to the first part of the document)"
      : "",
    "---BEGIN DOCUMENT---",
    input.content,
    "---END DOCUMENT---",
    "",
    "Respond with a single ```neko_library fence containing a JSON array of",
    "ops, and nothing else.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
