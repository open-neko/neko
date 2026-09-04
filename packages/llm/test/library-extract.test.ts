import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractDocumentText,
  extractViaLibrarian,
  librarianServiceUrl,
  sliceMarkdownSections,
} from "../src/library/extract";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "neko-library-extract-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

  it("returns Markdown and sections from a successful conversion", async () => {
    const md = "# Refund policy\n\nRefunds within 30 days.";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ document: { md_content: md }, status: "success" }));
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
      expect(outcome.structure.sections[0].headingPath).toEqual(["Refund policy"]);
    }
  });

  it("fails on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const outcome = await extractViaLibrarian({
      absolutePath: file,
      filename: "doc.pdf",
      baseUrl: "http://librarian:5001",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("500");
  });

  it("fails when the conversion status is failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ document: { md_content: "" }, status: "failure" }),
    );
    const outcome = await extractViaLibrarian({
      absolutePath: file,
      filename: "doc.pdf",
      baseUrl: "http://librarian:5001",
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("extractDocumentText (librarian-only, no fallback)", () => {
  const saved = process.env.NEKO_LIBRARIAN_URL;
  let file: string;
  beforeEach(async () => {
    file = join(dir, "policy.docx");
    await writeFile(file, "binary-docx-bytes", "utf8");
    process.env.NEKO_LIBRARIAN_URL = "http://librarian:5001";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEKO_LIBRARIAN_URL;
    else process.env.NEKO_LIBRARIAN_URL = saved;
  });

  it("fails when the service is not configured", async () => {
    delete process.env.NEKO_LIBRARIAN_URL;
    const outcome = await extractDocumentText({ absolutePath: file, filename: "policy.docx" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("NEKO_LIBRARIAN_URL");
  });

  it("routes the document through the service and returns structured Markdown", async () => {
    const md = "# Vacation policy\n\n20 days, carry-over max 5.";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ document: { md_content: md }, status: "success" }),
    );
    const outcome = await extractDocumentText({ absolutePath: file, filename: "policy.docx" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toBe(md);
      expect(outcome.structure.sections[0].headingPath).toEqual(["Vacation policy"]);
    }
  });

  it("does NOT fall back — a service error fails the extraction outright", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 502 }));
    const outcome = await extractDocumentText({ absolutePath: file, filename: "policy.docx" });
    expect(outcome.ok).toBe(false);
  });
});
