// Structure-aware chunking for the library distiller. Large documents are
// split on heading boundaries (from the extractor's section map) into windows
// under a per-chunk budget, so the distiller can process the whole document in
// a map-reduce pass instead of truncating it to a prefix. Boundaries fall on
// headings, so a concept rarely straddles two chunks; the heading trail is
// carried as context for the model.

import type { ExtractedSection } from "./extract";

export type DocumentChunk = {
  /** 1-based position in the sequence. */
  index: number;
  /** Total chunks for this document (1 when it fits in a single pass). */
  total: number;
  /** Heading trail of the first section in this chunk, as context. */
  headingPath: string[];
  /** The slice of the document this chunk covers. */
  text: string;
};

// Per-chunk character budget, comfortably under a small model's context once
// the prompt scaffolding (instructions + catalog) is added on top.
export const DISTILL_CHUNK_LIMIT = 48_000;

/**
 * Plan the chunks for one document. Consecutive sections are packed into
 * chunks under `maxChars`; a single section larger than the budget is
 * hard-split into windows. A document that already fits is returned as one
 * chunk with no heading framing (identical to the pre-chunking behavior).
 */
export function planDocumentChunks(
  text: string,
  sections: ExtractedSection[],
  maxChars: number = DISTILL_CHUNK_LIMIT,
): DocumentChunk[] {
  if (text.length <= maxChars) {
    return [{ index: 1, total: 1, headingPath: [], text }];
  }

  // Fall back to a single whole-document span when the extractor gave us no
  // structure — it will be windowed below.
  const spans: ExtractedSection[] =
    sections.length > 0 ? sections : [{ headingPath: [], start: 0, end: text.length }];

  type Raw = { headingPath: string[]; text: string };
  const raws: Raw[] = [];
  let curText = "";
  let curHeading: string[] | null = null;
  const flush = () => {
    if (curText.length > 0) {
      raws.push({ headingPath: curHeading ?? [], text: curText });
      curText = "";
      curHeading = null;
    }
  };

  for (const section of spans) {
    const sliceText = text.slice(section.start, section.end);
    if (sliceText.length === 0) continue;
    if (sliceText.length > maxChars) {
      // One section is bigger than a whole chunk: flush what we have, then
      // window the oversized section on its own.
      flush();
      for (let i = 0; i < sliceText.length; i += maxChars) {
        raws.push({ headingPath: section.headingPath, text: sliceText.slice(i, i + maxChars) });
      }
      continue;
    }
    if (curText.length + sliceText.length > maxChars) flush();
    if (curHeading === null) curHeading = section.headingPath;
    curText += sliceText;
  }
  flush();

  const total = raws.length;
  return raws.map((raw, i) => ({
    index: i + 1,
    total,
    headingPath: raw.headingPath,
    text: raw.text,
  }));
}
