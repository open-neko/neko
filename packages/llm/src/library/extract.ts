// Text extraction for the librarian, backed by the bundled
// document-extraction skill's script (assets/builtin-skills/
// document-extraction/scripts/extract_text.py). Text-shaped formats are
// read in-process; binary document formats shell out to the script,
// which degrades from best-available library to CLI tools to
// stdlib-only parsing (see the skill's SKILL.md and skill-deps.ts).
//
// A high-fidelity extractor (Docling) is available as an OPT-IN profile,
// gated by NEKO_DOCLING_EXTRACTION=true. When enabled it returns structured
// Markdown plus heading-based section boundaries (see ExtractOutcome.structure)
// so the distiller can chunk large documents on natural boundaries instead of
// raw offsets. It falls back to the bundled extractor on any failure — a
// missing `docling` install never fails an upload — which keeps the default
// slim images unchanged (Docling is not baked in; operators opt in).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));

export const EXTRACTION_SCRIPT_PATH = resolve(
  HERE,
  "..",
  "..",
  "assets",
  "builtin-skills",
  "document-extraction",
  "scripts",
  "extract_text.py",
);

export const DOCLING_SCRIPT_PATH = resolve(
  HERE,
  "..",
  "..",
  "assets",
  "builtin-skills",
  "document-extraction",
  "scripts",
  "extract_docling.py",
);

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  ".log",
  ".html",
  ".htm",
  ".xml",
]);

const SCRIPT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);

const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;
const SCRIPT_MAX_CHARS = 400_000;

// Formats Docling handles well. .html is included even though the builtin
// path reads it in-process — Docling's structure output is richer, and the
// fallback covers it either way.
const DOCLING_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".html",
  ".htm",
]);
// Docling can be slow on large scanned PDFs; give it more headroom than the
// builtin script. Large documents are the whole reason this path exists.
const DOCLING_TIMEOUT_MS = 10 * 60 * 1000;
// Unlike the builtin path's 400k prefix truncation, Docling is meant to
// return the whole document — downstream chunking is the size control. This
// is only a safety ceiling against a pathological conversion.
const DOCLING_MAX_CHARS = 5_000_000;

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
      text: string;
      /**
       * Present only when a structure-aware extractor (Docling) produced the
       * text: `text` is Markdown and `sections` are its heading boundaries,
       * ready to feed structure-aware chunking. Absent for the builtin path.
       */
      structure?: { format: "markdown"; sections: ExtractedSection[] };
    }
  | { ok: false; reason: string };

/** Opt-in flag: route supported formats through the Docling extractor. */
export function doclingExtractionEnabled(): boolean {
  return process.env.NEKO_DOCLING_EXTRACTION === "true";
}

export async function extractDocumentText(input: {
  absolutePath: string;
  filename: string;
}): Promise<ExtractOutcome> {
  const ext = extensionOf(input.filename);
  if (doclingExtractionEnabled() && DOCLING_EXTENSIONS.has(ext)) {
    const docling = await extractWithDocling(input);
    if (docling.ok) return docling;
    // Degrade to the builtin extractor rather than failing the upload — a
    // missing docling install or a single-document conversion error should
    // never block cataloging.
    console.warn(
      `[library] docling extraction failed for "${input.filename}" (${docling.reason}); falling back to the builtin extractor`,
    );
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    const raw = await readFile(input.absolutePath);
    const text = decodeText(raw);
    return {
      ok: true,
      text: ext === ".html" || ext === ".htm" || ext === ".xml" ? stripMarkup(text) : text,
    };
  }
  if (!SCRIPT_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `unsupported extension "${ext || "(none)"}"` };
  }
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [
        EXTRACTION_SCRIPT_PATH,
        input.absolutePath,
        `--max-chars=${SCRIPT_MAX_CHARS}`,
      ],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    return { ok: true, text: stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") {
      return {
        ok: false,
        reason:
          "python3 is not installed on the worker — the document-extraction skill needs it (see `pnpm skills:check`)",
      };
    }
    if (e.killed) {
      return { ok: false, reason: "text extraction timed out" };
    }
    const stderr = (e.stderr ?? "").trim().split("\n").at(-1) ?? "";
    return {
      ok: false,
      reason: stderr || `text extraction failed for "${input.filename}"`,
    };
  }
}

/**
 * High-fidelity extraction via the Docling script: one document in,
 * structured Markdown out, with heading boundaries computed on this side so
 * the Python stays single-purpose and the slicing stays unit-testable
 * without a docling install.
 */
export async function extractWithDocling(input: {
  absolutePath: string;
  filename: string;
}): Promise<ExtractOutcome> {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [DOCLING_SCRIPT_PATH, input.absolutePath, `--max-chars=${DOCLING_MAX_CHARS}`],
      {
        timeout: DOCLING_TIMEOUT_MS,
        maxBuffer: 128 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    const markdown = stdout;
    if (!markdown.trim()) {
      return { ok: false, reason: "docling returned no text" };
    }
    return {
      ok: true,
      text: markdown,
      structure: { format: "markdown", sections: sliceMarkdownSections(markdown) },
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") {
      return { ok: false, reason: "python3 is not installed on the worker" };
    }
    if (e.killed) {
      return { ok: false, reason: "docling extraction timed out" };
    }
    const stderr = (e.stderr ?? "").trim().split("\n").at(-1) ?? "";
    return {
      ok: false,
      reason: stderr || `docling extraction failed for "${input.filename}"`,
    };
  }
}

const ATX_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^(```+|~~~+)/;

/**
 * Split extracted Markdown into heading-delimited sections with character
 * offsets and an ancestor heading trail. Pure and dependency-free so the
 * distiller's structure-aware chunking can group concepts by section without
 * needing docling installed. Headings inside fenced code blocks are ignored.
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

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx).toLowerCase() : "";
}

/** utf-8 (BOM-stripped) with a latin-1 rescue when the bytes clearly aren't UTF-8. */
export function decodeText(raw: Buffer): string {
  const utf8 = raw.toString("utf8");
  const replacements = (utf8.match(/�/g) ?? []).length;
  const text =
    replacements > 0 && replacements > utf8.length / 200
      ? raw.toString("latin1")
      : utf8;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function stripMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
