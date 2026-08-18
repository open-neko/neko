// First-stage triage for the library distiller: decide cheaply, before
// spending an LLM pass, whether an upload looks like durable knowledge
// (policies, contracts, SOPs, notes) or one-off working data (a CSV
// dropped in to make a chart). The distilling agent performs the second
// stage and can still emit a `skip` op after reading the content.

export type TriageDecision =
  | { action: "distill" }
  | { action: "skip"; reason: string };

const KNOWLEDGE_EXTENSIONS = new Set([
  ".md",
  ".pdf",
  ".docx",
  ".pptx",
  ".html",
  ".txt",
]);
const DATA_EXTENSIONS = new Set([".csv", ".tsv", ".json", ".xlsx"]);

// A data-shaped file this small with mostly prose lines may still be a
// pasted policy or notes export — let the distiller look at it.
const SMALL_DATA_BYTES = 16 * 1024;

export function triageUpload(input: {
  filename: string;
  size: number;
  /** First few KB of extracted text, if cheaply available. */
  sample?: string;
}): TriageDecision {
  const ext = extension(input.filename);
  if (KNOWLEDGE_EXTENSIONS.has(ext)) return { action: "distill" };
  if (!DATA_EXTENSIONS.has(ext)) {
    return { action: "skip", reason: `unsupported extension "${ext || "(none)"}"` };
  }
  if (input.size > SMALL_DATA_BYTES) {
    return {
      action: "skip",
      reason: "data-shaped file (likely one-off working data, not knowledge)",
    };
  }
  if (input.sample && looksLikeProse(input.sample)) return { action: "distill" };
  return {
    action: "skip",
    reason: "small data-shaped file without prose content",
  };
}

function extension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx).toLowerCase() : "";
}

/**
 * Rough prose detector: knowledge text has long, word-heavy lines;
 * tabular/structured data has short delimiter-heavy lines.
 */
function looksLikeProse(sample: string): boolean {
  const lines = sample
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (lines.length === 0) return false;
  let prose = 0;
  for (const line of lines) {
    const words = line.split(/\s+/).length;
    const delimiters = (line.match(/[,;|{}[\]":]/g) ?? []).length;
    if (words >= 6 && delimiters < words) prose += 1;
  }
  return prose / lines.length >= 0.5;
}
