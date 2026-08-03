import { describe, expect, it } from "vitest";
import {
  normalizeRecordSavedViewDefinition,
  RecordSavedViewError,
} from "../src/saved-view";

describe("saved view definitions", () => {
  it("normalizes a typed filter AST without preserving executable query text", () => {
    expect(
      normalizeRecordSavedViewDefinition({
        version: 1,
        filter: {
          op: "and",
          clauses: [
            { field: "status", operator: "is_open" },
            {
              field: "due_at",
              operator: "relative",
              value: { macro: "last_n_days", days: 30 },
            },
          ],
        },
        sort: { field: "due_at", direction: "desc" },
        search: "  priority  ",
        myRecords: true,
        columns: ["name", "status", "name"],
        graphql: "query { secrets }",
      }),
    ).toEqual({
      version: 1,
      filter: {
        op: "and",
        clauses: [
          { field: "status", operator: "is_open" },
          {
            field: "due_at",
            operator: "relative",
            value: { macro: "last_n_days", days: 30 },
          },
        ],
      },
      sort: { field: "due_at", direction: "desc" },
      search: "priority",
      myRecords: true,
      columns: ["name", "status"],
    });
  });

  it("rejects unknown operators, identifiers, versions, and oversized groups", () => {
    expect(() =>
      normalizeRecordSavedViewDefinition({
        version: 2,
        filter: null,
      }),
    ).toThrow(RecordSavedViewError);
    expect(() =>
      normalizeRecordSavedViewDefinition({
        version: 1,
        filter: { field: "status) { secret }", operator: "eq", value: "open" },
      }),
    ).toThrow(/field is invalid/);
    expect(() =>
      normalizeRecordSavedViewDefinition({
        version: 1,
        filter: { field: "status", operator: "raw_graphql", value: "open" },
      }),
    ).toThrow(/operator is invalid/);
  });
});
