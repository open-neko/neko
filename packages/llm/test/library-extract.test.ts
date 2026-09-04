import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractDirectText,
  fetchLibrarianExtraction,
  librarianServiceUrl,
  pollLibrarianExtraction,
  RetryableLibraryExtractionError,
  sliceMarkdownSections,
  submitLibrarianExtraction,
  TerminalLibraryExtractionError,
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

  it("captures nested headings while ignoring headings inside code fences", () => {
    const md = [
      "Intro",
      "# A",
      "text",
      "```",
      "# not a heading",
      "```",
      "## B ##",
      "more",
    ].join("\n");
    expect(sliceMarkdownSections(md).map((section) => section.headingPath)).toEqual([
      [],
      ["A"],
      ["A", "B"],
    ]);
  });
});

describe("librarianServiceUrl", () => {
  const saved = process.env.NEKO_LIBRARIAN_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEKO_LIBRARIAN_URL;
    else process.env.NEKO_LIBRARIAN_URL = saved;
  });

  it("is null when unset and trims trailing slashes", () => {
    delete process.env.NEKO_LIBRARIAN_URL;
    expect(librarianServiceUrl()).toBeNull();
    process.env.NEKO_LIBRARIAN_URL = "http://librarian:5001/";
    expect(librarianServiceUrl()).toBe("http://librarian:5001");
  });
});

describe("asynchronous librarian API", () => {
  let file: string;

  beforeEach(async () => {
    file = join(dir, "doc.pdf");
    await writeFile(file, "%PDF-1.4 digital", "utf8");
  });

  it("submits exact format with OCR and image enrichment disabled", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ task_id: "task-1", task_status: "pending" }));
    await expect(
      submitLibrarianExtraction({
        absolutePath: file,
        filename: "doc.pdf",
        baseUrl: "http://librarian:5001",
      }),
    ).resolves.toBe("task-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://librarian:5001/v1/convert/file/async");
    const form = init?.body as FormData;
    expect(form.get("from_formats")).toBe("pdf");
    expect(form.get("do_ocr")).toBe("false");
    expect(form.get("force_ocr")).toBe("false");
    expect(form.get("do_picture_description")).toBe("false");
    expect(form.get("include_images")).toBe("false");
  });

  it("polls state and treats a missing task as retryable resubmission", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ task_id: "task-1", task_status: "started" }),
      )
      .mockResolvedValueOnce(jsonResponse({ detail: "not found" }, 404));
    await expect(
      pollLibrarianExtraction("http://librarian:5001", "task-1"),
    ).resolves.toMatchObject({ state: "started" });
    await expect(
      pollLibrarianExtraction("http://librarian:5001", "gone"),
    ).rejects.toMatchObject({
      name: "RetryableLibraryExtractionError",
      taskMissing: true,
    });
  });

  it("returns structured Markdown only for a non-empty successful result", async () => {
    const md = "# Refund policy\n\nRefunds within 30 days.";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ document: { md_content: md }, status: "success" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ document: { md_content: "" }, status: "success" }),
      );
    const outcome = await fetchLibrarianExtraction(
      "http://librarian:5001",
      "task-1",
    );
    expect(outcome.ok && outcome.text).toBe(md);
    await expect(
      fetchLibrarianExtraction("http://librarian:5001", "task-2"),
    ).rejects.toThrow(/Scanned and handwritten documents are not supported/);
  });

  it("resubmits when a completed task disappears before result retrieval", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "not found" }, 404),
    );

    await expect(
      fetchLibrarianExtraction("http://librarian:5001", "gone"),
    ).rejects.toMatchObject({
      name: "RetryableLibraryExtractionError",
      taskMissing: true,
    });
  });

  it("classifies service outages as retryable and rejected inputs as terminal", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("bad", { status: 415 }));
    await expect(
      pollLibrarianExtraction("http://librarian:5001", "task-1"),
    ).rejects.toBeInstanceOf(RetryableLibraryExtractionError);
    await expect(
      pollLibrarianExtraction("http://librarian:5001", "task-1"),
    ).rejects.toBeInstanceOf(TerminalLibraryExtractionError);
  });
});

describe("direct Markdown and text extraction", () => {
  it("reads UTF-8 text without a service and preserves all content", async () => {
    const file = join(dir, "agent-note.md");
    const text = "# Generated note\n\nKeep all of this.";
    await writeFile(file, text, "utf8");
    const outcome = await extractDirectText(file);
    expect(outcome.ok && outcome.text).toBe(text);
  });

  it("rejects empty and binary-looking text", async () => {
    const empty = join(dir, "empty.txt");
    const binary = join(dir, "binary.txt");
    await writeFile(empty, "   ", "utf8");
    await writeFile(binary, Buffer.from([65, 0, 66]));
    await expect(extractDirectText(empty)).rejects.toThrow(/empty/);
    await expect(extractDirectText(binary)).rejects.toThrow(/binary/);
  });
});
