import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeText,
  extractDocumentText,
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
