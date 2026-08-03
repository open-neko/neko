import { describe, expect, it } from "vitest";
import {
  parseRecordAppPage,
  RecordAppPageDefinitionError,
} from "../src/app-page";

describe("record app pages", () => {
  it("normalizes the closed metric/list/timeline block set", () => {
    const parsed = parseRecordAppPage({
        blocks: [
          {
            label: "Open pipeline",
            renderer: "metric",
            span: 1,
            query: {
              object: "opportunity",
              aggregate: "sum",
              field: "amount",
              where: { stage: { not_in: ["closed_won", "closed_lost"] } },
            },
          },
          {
            label: "Recent activity",
            renderer: "timeline",
            span: 3,
            query: {
              object: "activity",
              filter: {
                field: "occurred_at",
                operator: "relative",
                value: { macro: "last_n_days", days: 30 },
              },
              sort: [{ field: "occurred_at", direction: "desc" }],
              limit: 12,
            },
          },
        ],
      });
    expect(parsed).toMatchObject({
      blocks: [
        {
          renderer: "metric",
          query: {
            aggregate: "sum",
            field: "amount",
            filter: {
              field: "stage",
              operator: "not_in",
              value: ["closed_won", "closed_lost"],
            },
          },
        },
        {
          renderer: "timeline",
          query: {
            aggregate: null,
            sort: { field: "occurred_at", direction: "desc" },
          },
        },
      ],
    });
    expect(parseRecordAppPage(parsed)).toEqual(parsed);
  });

  it("rejects arbitrary renderers, executable view names, and malformed metrics", () => {
    expect(() =>
      parseRecordAppPage({
        blocks: [{ label: "Unsafe", renderer: "html", query: { object: "deal" } }],
      }),
    ).toThrow(RecordAppPageDefinitionError);
    expect(() =>
      parseRecordAppPage({
        blocks: [{
          label: "Named query",
          renderer: "list",
          query: { object: "deal", view: "raw_graphql" },
        }],
      }),
    ).toThrow(/semantic filter/);
    expect(() =>
      parseRecordAppPage({
        blocks: [{
          label: "Broken metric",
          renderer: "metric",
          query: { object: "deal", aggregate: "sum" },
        }],
      }),
    ).toThrow(/require a field/);
  });
});
