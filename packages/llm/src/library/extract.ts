// Document extraction for the library distiller. There is exactly one
// extractor: the librarian service (Docling's docling-serve, a separate
// container). The worker POSTs every upload to that service and gets back
// structured Markdown plus heading-based section boundaries (see
// ExtractOutcome.structure), which lets the distiller chunk large documents
// on natural boundaries instead of raw offsets.
//
// There is deliberately NO fallback. If the service is not configured or a
// conversion fails, extraction fails with a clear reason; the distill job
// marks the document row failed and it is retryable from /library. We never
// silently degrade to a lower-fidelity extractor and catalog worse text.

import { readFile } from "node:fs/promises";

// The service can be slow on large scanned PDFs (layout + OCR); give it far
// more headroom than a quick text read. Large documents are the whole reason
// this path exists.
const LIBRARIAN_TIMEOUT_MS = 10 * 60 * 1000;

/** One heading-delimited region of an extracted Markdown document. */
export type ExtractedSection = {
  /**
   * Heading trail from the document root to this section, self last
   * (e.g. ["Master Agreement", "3. Payment terms"]). Empty for the
   * preamble before the first heading.
   */
  headingPath: string[];
  /** Character offset of the section start in the returned text. */
  start: number;
  /** Character offset of the section end (exclusive). */
  end: number;
};

export type ExtractOutcome =
  | {
      ok: true;
      /** Structured Markdown from Docling. */
      text: string;
      /** Heading boundaries of `text`, ready to feed structure-aware chunking. */
      structure: { format: "markdown"; sections: ExtractedSection[] };
    }
  | { ok: false; reason: string };

/**
 * Base URL of the librarian extraction service (docling-serve), or null when
 * it isn't configured. The library requires it — a null here makes extraction
 * fail loudly rather than fall back.
 */
export function librarianServiceUrl(): string | null {
  const raw = process.env.NEKO_LIBRARIAN_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export async function extractDocumentText(input: {
  absolutePath: string;
  filename: string;
}): Promise<ExtractOutcome> {
  const baseUrl = librarianServiceUrl();
  if (!baseUrl) {
    return {
      ok: false,
      reason:
        "librarian service is not configured — set NEKO_LIBRARIAN_URL; the library requires it for extraction",
    };
  }
  return extractViaLibrarian({ ...input, baseUrl });
}

type DoclingConvertResponse = {
  document?: { md_content?: string | null };
  status?: string;
  errors?: unknown[];
};

/**
 * Extraction via the librarian service (docling-serve): POST the document to
 * /v1/convert/file, get structured Markdown back, and compute heading
 * boundaries on this side so the slicing stays unit-testable without the
 * service running. Any transport/conversion failure is returned as ok:false
 * so the distill job can mark the row failed (and retry) — never fall back.
 */
export async function extractViaLibrarian(input: {
  absolutePath: string;
  filename: string;
  baseUrl: string;
}): Promise<ExtractOutcome> {
  try {
    const bytes = await readFile(input.absolutePath);
    const form = new FormData();
    // docling-serve infers the source format from the uploaded filename.
    form.append("files", new Blob([new Uint8Array(bytes)]), input.filename);
    form.append("to_formats", "md");
    const res = await fetch(`${input.baseUrl}/v1/convert/file`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(LIBRARIAN_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reason: `librarian service returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as DoclingConvertResponse;
    const markdown = data.document?.md_content ?? "";
    if (data.status === "failure" || !markdown.trim()) {
      return {
        ok: false,
        reason: `librarian conversion ${data.status ?? "returned no text"}`,
      };
    }
    return {
      ok: true,
      text: markdown,
      structure: { format: "markdown", sections: sliceMarkdownSections(markdown) },
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

const ATX_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^(```+|~~~+)/;

/**
 * Split extracted Markdown into heading-delimited sections with character
 * offsets and an ancestor heading trail. Pure and dependency-free so the
 * distiller's structure-aware chunking can group concepts by section without
 * the service running. Headings inside fenced code blocks are ignored.
 */
export function sliceMarkdownSections(markdown: string): ExtractedSection[] {
  type Boundary = { offset: number; level: number; title: string };
  const boundaries: Boundary[] = [];
  let offset = 0;
  let inFence = false;
  let fenceChar = "";
  for (const line of markdown.split("\n")) {
    const fence = FENCE.exec(line.trimStart());
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (line.trimStart().startsWith(fenceChar)) {
        inFence = false;
      }
    } else if (!inFence) {
      const m = ATX_HEADING.exec(line);
      if (m) boundaries.push({ offset, level: m[1].length, title: m[2].trim() });
    }
    offset += line.length + 1; // +1 for the "\n" removed by split
  }

  const total = markdown.length;
  const sections: ExtractedSection[] = [];
  const firstStart = boundaries.length > 0 ? boundaries[0].offset : total;
  if (firstStart > 0 && markdown.slice(0, firstStart).trim().length > 0) {
    sections.push({ headingPath: [], start: 0, end: firstStart });
  }
  const stack: Boundary[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    while (stack.length > 0 && stack[stack.length - 1].level >= b.level) stack.pop();
    stack.push(b);
    const end = i + 1 < boundaries.length ? boundaries[i + 1].offset : total;
    sections.push({ headingPath: stack.map((s) => s.title), start: b.offset, end });
  }
  if (sections.length === 0) sections.push({ headingPath: [], start: 0, end: total });
  return sections;
}
