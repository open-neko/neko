// Text extraction for the librarian, backed by the bundled
// document-extraction skill's script (assets/builtin-skills/
// document-extraction/scripts/extract_text.py). Text-shaped formats are
// read in-process; binary document formats shell out to the script,
// which degrades from best-available library to CLI tools to
// stdlib-only parsing (see the skill's SKILL.md and skill-deps.ts).

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

export type ExtractOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export async function extractDocumentText(input: {
  absolutePath: string;
  filename: string;
}): Promise<ExtractOutcome> {
  const ext = extensionOf(input.filename);
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
