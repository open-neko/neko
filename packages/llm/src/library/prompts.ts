// Prompt builder for the library distiller ("the librarian"): given one
// uploaded document plus the current concept catalog, the model emits
// neko_library fence ops (see fence.ts). Update-not-append is the core
// instruction — re-uploads revise existing concepts instead of creating
// duplicates, and contradictions get flagged inside the affected concept.

export type DistillPromptInput = {
  filename: string;
  /** Extracted text of the document (or of one part, when chunked). */
  content: string;
  /** Existing concept paths with titles/descriptions, for update-not-append. */
  catalog: Array<{ path: string; title: string; description?: string }>;
  /**
   * Set when a large document is distilled in parts. `total > 1` switches the
   * prompt into chunk mode: the model is told this is one part, given the
   * part's heading context, and shown the concepts already extracted from
   * earlier parts so it reuses their paths instead of duplicating.
   */
  chunk?: { index: number; total: number; headingPath?: string[] };
  /** Concepts already extracted from earlier parts of THIS document. */
  priorConcepts?: Array<{ path: string; title: string }>;
};

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

  const isChunk = (input.chunk?.total ?? 1) > 1;
  const partRule = isChunk
    ? "- This is ONE PART of a larger document. Extract concepts from THIS part" +
      " only, and reuse a path from the catalog or the earlier-parts list when" +
      " this part continues or revises the same topic, so a concept spanning" +
      " parts is merged rather than duplicated."
    : "";
  const priorList =
    isChunk && input.priorConcepts && input.priorConcepts.length > 0
      ? [
          "Concepts already extracted from earlier parts of this document",
          "(reuse these exact paths to continue them):",
          ...input.priorConcepts.map((c) => `- ${c.path} — ${c.title}`),
          "",
        ].join("\n")
      : "";
  const headingContext =
    isChunk && input.chunk?.headingPath && input.chunk.headingPath.length > 0
      ? `This part appears under: ${input.chunk.headingPath.join(" > ")}`
      : "";
  const documentHeader = isChunk
    ? `Uploaded document (part ${input.chunk?.index} of ${input.chunk?.total}): ${input.filename}`
    : `Uploaded document: ${input.filename}`;

  return [
    "You are the librarian for a business knowledge library. You are given",
    "one uploaded document. Distill every part into useful business knowledge",
    "without dropping tables, appendices, notes, or inconvenient details.",
    "",
    "Rules:",
    partRule,
    "- Emit one `upsert` per distinct topic. Write the",
    "  concept body as concise reference markdown: what the document",
    "  establishes, key numbers/dates/obligations, and anything a teammate",
    "  would need without reading the original.",
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
    "- If the document has an explicit expiry or effective-until date",
    '  (contract end, policy review date), set `stale_after` (YYYY-MM-DD)',
    "  on the op so the concept is retired automatically. Omit it",
    "  otherwise — never guess a date.",
    "- Use exactly these JSON object shapes; every object is flat and `op`",
    "  is the discriminator:",
    '  Upsert: {"op": "upsert", "path": "policies/refund-policy.md",',
    '  "type": "Policy", "title": "Refund policy", "description": "...",',
    '  "tags": ["finance"], "body": "reference markdown",',
    '  "stale_after": "YYYY-MM-DD"}',
    "  Do not wrap the fields inside an `upsert` object.",
    "",
    "Current catalog:",
    catalog,
    "",
    priorList,
    documentHeader,
    headingContext,
    "---BEGIN DOCUMENT---",
    input.content,
    "---END DOCUMENT---",
    "",
    "Respond with a single ```neko_library fence containing a JSON array of",
    "the flat operation objects above, and nothing else.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
