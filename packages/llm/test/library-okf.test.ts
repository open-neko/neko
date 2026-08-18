import { describe, expect, it } from "vitest";
import {
  conceptSlug,
  parseConceptDoc,
  serializeConceptDoc,
  type OkfConceptDoc,
} from "../src/library/okf";

describe("OKF concept doc serializer", () => {
  const doc: OkfConceptDoc = {
    type: "Policy",
    title: "Refund policy",
    description: "How refunds are approved and processed.",
    tags: ["finance", "support"],
    sources: [
      {
        resource: "/library/uploads/u1/refund-policy.pdf",
        last_modified: "2026-08-01T00:00:00.000Z",
      },
    ],
    generated: { by: "openneko/2.26.4", at: "2026-08-18T00:00:00.000Z" },
    verified: [{ by: "human:amit", at: "2026-08-18T01:00:00.000Z" }],
    status: "stable",
    stale_after: "2027-08-18",
    extra: { openneko_document_id: "doc-1" },
    body: "# Rules\n\nRefunds over $500 need CFO approval.",
  };

  it("round-trips through serialize/parse", () => {
    const raw = serializeConceptDoc(doc);
    const parsed = parseConceptDoc(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(doc);
  });

  it("puts type first and starts with frontmatter", () => {
    const raw = serializeConceptDoc(doc);
    expect(raw.startsWith("---\ntype: Policy\n")).toBe(true);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("omits empty optional collections", () => {
    const raw = serializeConceptDoc({ type: "Note", tags: [], body: "x" });
    expect(raw).not.toContain("tags:");
    expect(raw).not.toContain("sources:");
  });

  it("requires a non-empty type to parse", () => {
    expect(parseConceptDoc("---\ntitle: no type\n---\nbody")).toBeNull();
    expect(parseConceptDoc("---\ntype: ''\n---\nbody")).toBeNull();
  });

  it("returns null for files without frontmatter", () => {
    expect(parseConceptDoc("# just markdown\n")).toBeNull();
  });

  it("tolerates unknown frontmatter keys per OKF conformance", () => {
    const parsed = parseConceptDoc(
      "---\ntype: Note\nmystery_key: 42\n---\n\nbody text\n",
    );
    expect(parsed?.type).toBe("Note");
    expect(parsed?.extra).toEqual({ mystery_key: 42 });
    expect(parsed?.body).toBe("body text");
  });

  it("accepts string-form sources", () => {
    const parsed = parseConceptDoc(
      "---\ntype: Note\nsources:\n  - /library/uploads/a.pdf\n---\nbody",
    );
    expect(parsed?.sources).toEqual([{ resource: "/library/uploads/a.pdf" }]);
  });

  it("normalizes a single verified stamp into a list", () => {
    const parsed = parseConceptDoc(
      "---\ntype: Note\nverified:\n  by: human:a\n  at: 2026-08-18T00:00:00Z\n---\nbody",
    );
    expect(parsed?.verified).toEqual([
      { by: "human:a", at: "2026-08-18T00:00:00Z" },
    ]);
  });

  it("survives malformed YAML without throwing", () => {
    expect(parseConceptDoc("---\n: [ not yaml\n---\nbody")).toBeNull();
  });
});

describe("conceptSlug", () => {
  it("slugs titles like workflow slugs", () => {
    expect(conceptSlug("Refund Policy (v2)!")).toBe("refund-policy-v2");
  });
  it("never returns an empty slug", () => {
    expect(conceptSlug("!!!")).toBe("concept");
  });
});
