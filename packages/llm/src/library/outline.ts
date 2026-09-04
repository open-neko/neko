// Outline-then-zoom: before distilling a large document chunk by chunk, a
// single cheap pass over its section outline (heading + size + lead snippet)
// picks which sections carry durable business knowledge worth cataloging.
// Only the selected sections are then distilled in full — a raw-data appendix
// or a signature block never costs a full distillation call. The selection can
// only NARROW: an unparseable or empty reply falls back to distilling
// everything, so outlining never drops knowledge, only saves cost.

import type { ExtractedSection } from "./extract";

export type OutlineEntry = {
  index: number;
  headingPath: string[];
  chars: number;
  /** Whitespace-collapsed opening of the section, for the model to judge by. */
  lead: string;
};

const LEAD_CHARS = 200;

export function buildOutline(text: string, sections: ExtractedSection[]): OutlineEntry[] {
  return sections.map((section, index) => {
    const body = text.slice(section.start, section.end);
    return {
      index,
      headingPath: section.headingPath,
      chars: body.length,
      lead: body.replace(/\s+/g, " ").trim().slice(0, LEAD_CHARS),
    };
  });
}

export function buildOutlinePrompt(filename: string, outline: OutlineEntry[]): string {
  const lines = outline.map((e) => {
    const heading = e.headingPath.length > 0 ? e.headingPath.join(" > ") : "(preamble)";
    return `[${e.index}] ${heading} (${e.chars} chars): ${e.lead}`;
  });
  return [
    "You are triaging a large document before cataloging it into a business",
    "knowledge library. Below is its section outline: each line is an index,",
    "the heading path, the section size, and a lead snippet.",
    "",
    "Select the sections that contain DURABLE BUSINESS KNOWLEDGE worth",
    "cataloging — policies, contracts, procedures, definitions, obligations,",
    "org facts. EXCLUDE tables of contents, raw data dumps, figure/exhibit",
    "appendices, signature blocks, and filler.",
    "",
    `Document: ${filename}`,
    "Sections:",
    ...lines,
    "",
    "Respond with a single ```neko_outline fence containing JSON of the form",
    '{"distill": [<indices of sections to catalog>]} and nothing else.',
    "When unsure about a section, include it.",
  ].join("\n");
}

const OUTLINE_FENCE_RE = /```neko_outline\s*([\s\S]*?)```/i;

/**
 * Parse the outline reply into the set of section indices to distill. Returns
 * null when the reply can't be parsed — the caller then distills everything.
 */
export function parseOutlineSelection(raw: string, sectionCount: number): number[] | null {
  const match = OUTLINE_FENCE_RE.exec(raw);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as { distill?: unknown };
    if (!Array.isArray(parsed.distill)) return null;
    const indices = parsed.distill.filter(
      (n): n is number => Number.isInteger(n) && n >= 0 && n < sectionCount,
    );
    return Array.from(new Set(indices)).sort((a, b) => a - b);
  } catch {
    return null;
  }
}
