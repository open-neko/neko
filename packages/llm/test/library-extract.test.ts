import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeText,
  extractDocumentText,
  extractViaLibrarian,
  librarianServiceUrl,
  sliceMarkdownSections,
  stripMarkup,
} from "../src/library/extract";

const execFileAsync = promisify(execFile);

async function pythonAvailable(): Promise<boolean> {
  try {
    await execFileAsync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function pdfToolAvailable(): Promise<boolean> {
  try {
    await execFileAsync("python3", ["-c", "import pypdf"]);
    return true;
  } catch {
    try {
      await execFileAsync("pdftotext", ["-v"]);
      return true;
    } catch {
      return false;
    }
  }
}

const hasPython = await pythonAvailable();
const describeIfPython = hasPython ? describe : describe.skip;
if (!hasPython) {
  console.warn("[library-extract] skipping script paths: python3 unavailable.");
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "neko-library-extract-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("decodeText", () => {
  it("strips a UTF-8 BOM", () => {
    expect(decodeText(Buffer.from("﻿hello", "utf8"))).toBe("hello");
  });
  it("rescues latin-1 bytes", () => {
    expect(decodeText(Buffer.from("caf\xe9 cr\xe8me", "latin1"))).toBe("café crème");
  });
  it("keeps valid utf-8 as-is", () => {
    expect(decodeText(Buffer.from("café", "utf8"))).toBe("café");
  });
});

describe("stripMarkup", () => {
  it("removes tags, scripts, and styles", () => {
    expect(
      stripMarkup(
        "<html><style>b{}</style><script>x()</script><h1>Policy</h1><p>Refunds in 30 days.</p></html>",
      ),
    ).toBe("Policy Refunds in 30 days.");
  });
});

describe("sliceMarkdownSections", () => {
  it("returns one section spanning the whole doc when there are no headings", () => {
    const md = "Just some prose.\nNo headings here.";
    expect(sliceMarkdownSections(md)).toEqual([
      { headingPath: [], start: 0, end: md.length },
    ]);
  });

  it("captures a preamble before the first heading", () => {
    const md = "Intro line.\n\n# Title\n\nBody.";
    const sections = sliceMarkdownSections(md);
    expect(sections[0]).toEqual({ headingPath: [], start: 0, end: md.indexOf("# Title") });
    expect(sections[1].headingPath).toEqual(["Title"]);
    expect(sections[1].end).toBe(md.length);
  });

  it("builds an ancestor trail from nested headings", () => {
    const md = ["# A", "text", "## B", "more", "### C", "deep", "## D", "end"].join("\n");
    const paths = sliceMarkdownSections(md).map((s) => s.headingPath);
    expect(paths).toEqual([["A"], ["A", "B"], ["A", "B", "C"], ["A", "D"]]);
  });

  it("gives contiguous, non-overlapping offset ranges", () => {
    const md = ["# One", "aaa", "# Two", "bbb"].join("\n");
    const sections = sliceMarkdownSections(md);
    expect(sections[0].start).toBe(0);
    expect(sections[0].end).toBe(sections[1].start);
    expect(sections[1].end).toBe(md.length);
    // Slicing by offset recovers the original heading line.
    expect(md.slice(sections[1].start).startsWith("# Two")).toBe(true);
  });

  it("ignores '#' lines inside fenced code blocks", () => {
    const md = ["# Real", "```", "# not a heading", "```", "## Also real"].join("\n");
    expect(sliceMarkdownSections(md).map((s) => s.headingPath)).toEqual([
      ["Real"],
      ["Real", "Also real"],
    ]);
  });

  it("strips trailing closing hashes from ATX headings", () => {
    expect(sliceMarkdownSections("## Payment ##\nbody")[0].headingPath).toEqual([
      "Payment",
    ]);
  });
});

describe("librarianServiceUrl", () => {
  const saved = process.env.NEKO_LIBRARIAN_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEKO_LIBRARIAN_URL;
    else process.env.NEKO_LIBRARIAN_URL = saved;
  });
  it("is null when unset, and trims a trailing slash when set", () => {
    delete process.env.NEKO_LIBRARIAN_URL;
    expect(librarianServiceUrl()).toBeNull();
    process.env.NEKO_LIBRARIAN_URL = "http://librarian:5001/";
    expect(librarianServiceUrl()).toBe("http://librarian:5001");
  });
});

describe("extractViaLibrarian", () => {
  let file: string;
  beforeEach(async () => {
    file = join(dir, "doc.pdf");
    await writeFile(file, "%PDF-1.4 minimal", "utf8");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Markdown and sections from a successful conversion", async () => {
    const md = "# Refund policy\n\nRefunds within 30 days.";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ document: { md_content: md }, status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const outcome = await extractViaLibrarian({
      absolutePath: file,
      filename: "doc.pdf",
      baseUrl: "http://librarian:5001",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://librarian:5001/v1/convert/file",
      expect.objectContaining({ method: "POST" }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toBe(md);
      expect(outcome.structure?.sections[0].headingPath).toEqual(["Refund policy"]);
    }
  });

  it("fails (for fallback) on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const outcome = await extractViaLibrarian({
      absolutePath: file,
      filename: "doc.pdf",
      baseUrl: "http://librarian:5001",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("500");
  });

  it("fails (for fallback) when the conversion status is failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ document: { md_content: "" }, status: "failure" }), {
        status: 200,
      }),
    );
    const outcome = await extractViaLibrarian({
      absolutePath: file,
      filename: "doc.pdf",
      baseUrl: "http://librarian:5001",
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("extractDocumentText (in-process text formats)", () => {
  it("reads markdown directly", async () => {
    const file = join(dir, "notes.md");
    await writeFile(file, "# Notes\n\nRefunds in 30 days.", "utf8");
    const outcome = await extractDocumentText({ absolutePath: file, filename: "notes.md" });
    expect(outcome).toEqual({ ok: true, text: "# Notes\n\nRefunds in 30 days." });
  });

  it("strips html", async () => {
    const file = join(dir, "page.html");
    await writeFile(file, "<h1>Policy</h1><p>Refunds in 30 days.</p>", "utf8");
    const outcome = await extractDocumentText({ absolutePath: file, filename: "page.html" });
    expect(outcome).toEqual({ ok: true, text: "Policy Refunds in 30 days." });
  });

  it("rejects unsupported extensions", async () => {
    const outcome = await extractDocumentText({
      absolutePath: join(dir, "x.zip"),
      filename: "x.zip",
    });
    expect(outcome.ok).toBe(false);
  });
});

describeIfPython("extractDocumentText (bundled script)", () => {
  it("extracts docx built with stdlib zipfile", async () => {
    const file = join(dir, "policy.docx");
    await execFileAsync("python3", [
      "-c",
      [
        "import zipfile, sys",
        `z = zipfile.ZipFile(sys.argv[1], 'w')`,
        `z.writestr('[Content_Types].xml', '<Types/>')`,
        `z.writestr('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Vacation policy: 20 days.</w:t></w:r></w:p><w:p><w:r><w:t>Carry-over max 5 days.</w:t></w:r></w:p></w:body></w:document>')`,
        "z.close()",
      ].join("\n"),
      file,
    ]);
    const outcome = await extractDocumentText({ absolutePath: file, filename: "policy.docx" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("Vacation policy: 20 days.");
      expect(outcome.text).toContain("Carry-over max 5 days.");
    }
  });

  it("extracts xlsx cells including shared strings", async () => {
    const file = join(dir, "rates.xlsx");
    await execFileAsync("python3", [
      "-c",
      [
        "import zipfile, sys",
        `z = zipfile.ZipFile(sys.argv[1], 'w')`,
        `z.writestr('[Content_Types].xml', '<Types/>')`,
        `z.writestr('xl/sharedStrings.xml', '<sst><si><t>region</t></si><si><t>EU</t></si></sst>')`,
        `z.writestr('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c></row><row><c t="s"><v>1</v></c><c><v>0.21</v></c></row></sheetData></worksheet>')`,
        "z.close()",
      ].join("\n"),
      file,
    ]);
    const outcome = await extractDocumentText({ absolutePath: file, filename: "rates.xlsx" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("region");
      expect(outcome.text).toContain("EU\t0.21");
    }
  });

  it("falls back to the builtin extractor when the librarian service is unreachable", async () => {
    const file = join(dir, "policy.docx");
    await execFileAsync("python3", [
      "-c",
      [
        "import zipfile, sys",
        `z = zipfile.ZipFile(sys.argv[1], 'w')`,
        `z.writestr('[Content_Types].xml', '<Types/>')`,
        `z.writestr('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Fallback works: 20 days.</w:t></w:r></w:p></w:body></w:document>')`,
        "z.close()",
      ].join("\n"),
      file,
    ]);
    const saved = process.env.NEKO_LIBRARIAN_URL;
    // Point at a closed port so the fetch fails fast and the extractor must
    // degrade to the builtin path (which carries no `structure`).
    process.env.NEKO_LIBRARIAN_URL = "http://127.0.0.1:1";
    try {
      const outcome = await extractDocumentText({ absolutePath: file, filename: "policy.docx" });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.text).toContain("Fallback works: 20 days.");
        expect(outcome.structure).toBeUndefined();
      }
    } finally {
      if (saved === undefined) delete process.env.NEKO_LIBRARIAN_URL;
      else process.env.NEKO_LIBRARIAN_URL = saved;
    }
  });

  it("reports a reason when the file is missing", async () => {
    const outcome = await extractDocumentText({
      absolutePath: join(dir, "missing.docx"),
      filename: "missing.docx",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason.length).toBeGreaterThan(0);
  });

  it("extracts pdf text when a pdf tool is available", async () => {
    if (!(await pdfToolAvailable())) {
      console.warn("[library-extract] skipping pdf case: no pypdf/pdftotext.");
      return;
    }
    // Minimal single-page PDF with a text object, no libraries needed.
    const pdf = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
      "4 0 obj << /Length 60 >> stream",
      "BT /F1 12 Tf 72 720 Td (Refunds over 500 need approval) Tj ET",
      "endstream endobj",
      "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
    ].join("\n");
    const file = join(dir, "policy.pdf");
    await writeFile(file, pdf, "latin1");
    const outcome = await extractDocumentText({ absolutePath: file, filename: "policy.pdf" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.text).toContain("Refunds over 500 need approval");
  });
});
