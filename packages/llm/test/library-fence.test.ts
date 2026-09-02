import { describe, expect, it } from "vitest";
import {
  extractLibraryFences,
  isValidConceptPath,
} from "../src/library/fence";

const fence = (body: string) => "```neko_library\n" + body + "\n```";

describe("extractLibraryFences", () => {
  it("parses upsert ops and strips the fence", () => {
    const raw =
      "Cataloged the refund policy.\n\n" +
      fence(
        JSON.stringify([
          {
            upsert: {
              path: "policies/refund-policy.md",
              type: "Policy",
              title: "Refund policy",
              description: "Approval rules for refunds.",
              tags: ["finance"],
              body: "# Rules\n\nRefunds over $500 need CFO approval.",
            },
          },
        ]),
      );
    const { text, ops } = extractLibraryFences(raw);
    expect(text).toBe("Cataloged the refund policy.");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "upsert",
      path: "policies/refund-policy.md",
      type: "Policy",
      title: "Refund policy",
    });
  });

  it("parses skip ops", () => {
    const { ops } = extractLibraryFences(
      fence(JSON.stringify([{ skip: { reason: "one-off data" } }])),
    );
    expect(ops).toEqual([{ kind: "skip", reason: "one-off data" }]);
  });

  it("parses flat discriminator ops emitted by the librarian", () => {
    const { ops } = extractLibraryFences(
      fence(
        JSON.stringify([
          {
            op: "upsert",
            path: "presentations/sales-overview.md",
            type: "Notes",
            title: "Sales overview",
            description: "Positioning and capabilities from the sales deck.",
            tags: ["sales"],
            body: "# Sales overview\n\nDurable product positioning.",
          },
          { op: "skip", reason: "one-off working data" },
        ]),
      ),
    );
    expect(ops).toEqual([
      {
        kind: "upsert",
        path: "presentations/sales-overview.md",
        type: "Notes",
        title: "Sales overview",
        description: "Positioning and capabilities from the sales deck.",
        tags: ["sales"],
        body: "# Sales overview\n\nDurable product positioning.",
        stale_after: undefined,
      },
      { kind: "skip", reason: "one-off working data" },
    ]);
  });

  it("drops unknown flat operation discriminators", () => {
    const { ops } = extractLibraryFences(
      fence(
        JSON.stringify([
          {
            op: "delete",
            path: "presentations/sales-overview.md",
            type: "Notes",
            title: "Sales overview",
            body: "Must not be accepted.",
          },
        ]),
      ),
    );
    expect(ops).toEqual([]);
  });

  it("drops upserts with traversal or reserved paths", () => {
    const bad = [
      "../escape.md",
      "/absolute.md",
      "a/../b.md",
      "policies/index.md",
      "policies/log.md",
      "no-extension",
    ];
    for (const path of bad) {
      const { ops } = extractLibraryFences(
        fence(
          JSON.stringify([
            { upsert: { path, type: "Note", title: "t", body: "body" } },
          ]),
        ),
      );
      expect(ops, path).toEqual([]);
    }
  });

  it("strips malformed fences without producing ops", () => {
    const { text, ops } = extractLibraryFences("before " + fence("{ not json"));
    expect(ops).toEqual([]);
    expect(text).toBe("before");
  });

  it("handles multiple fences and non-array bodies", () => {
    const raw =
      fence(
        JSON.stringify({
          upsert: { path: "a.md", type: "Note", title: "A", body: "aaa" },
        }),
      ) +
      "\n" +
      fence(
        JSON.stringify([
          { upsert: { path: "b.md", type: "Note", title: "B", body: "bbb" } },
        ]),
      );
    const { ops } = extractLibraryFences(raw);
    expect(ops.map((o) => (o.kind === "upsert" ? o.path : ""))).toEqual([
      "a.md",
      "b.md",
    ]);
  });
});

describe("isValidConceptPath", () => {
  it("accepts nested lowercase slug paths", () => {
    expect(isValidConceptPath("policies/refund-policy.md")).toBe(true);
    expect(isValidConceptPath("a.md")).toBe(true);
  });
  it("rejects uppercase, spaces, and dotfiles", () => {
    expect(isValidConceptPath("Policies/Refund.md")).toBe(false);
    expect(isValidConceptPath("a b.md")).toBe(false);
    expect(isValidConceptPath(".hidden.md")).toBe(false);
  });
});
