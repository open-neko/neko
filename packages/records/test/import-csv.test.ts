import { describe, expect, it } from "vitest";
import { parseRecordsCsv, RecordsCsvParseError } from "../src/import/csv";

function encodeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function encodeCsv(rows: string[][]): string {
  return rows.map((row) => row.map(encodeField).join(",")).join("\r\n");
}

describe("records CSV parser", () => {
  it("parses BOM, CRLF, commas, escaped quotes, and embedded newlines", () => {
    const parsed = parseRecordsCsv(
      '\uFEFFName,Notes,Status\r\n"Rivera, Ada","First line\r\nSecond ""quoted"" line",active\r\n',
    );
    expect(parsed).toEqual({
      headers: ["Name", "Notes", "Status"],
      rows: [
        {
          rowNumber: 1,
          values: ["Rivera, Ada", 'First line\nSecond "quoted" line', "active"],
        },
      ],
    });
  });

  it("rejects ambiguous or malformed records", () => {
    expect(() => parseRecordsCsv("Name,name\nA,B")).toThrow(/duplicate CSV header/i);
    expect(() => parseRecordsCsv('name\n"unterminated')).toThrow(RecordsCsvParseError);
    expect(() => parseRecordsCsv('name\n"closed"junk')).toThrow(/closing quote/i);
    expect(() => parseRecordsCsv("a,b\n1")).toThrow(/expected 2/i);
    expect(() => parseRecordsCsv("\0name\nAda")).toThrow(/NUL/i);
  });

  it("round-trips a deterministic corpus of RFC-4180 fields", () => {
    const atoms = [
      "plain",
      "with,comma",
      'with "quote"',
      "two\nlines",
      "carriage\rreturn",
      "",
      " spaced ",
      "équipement",
    ];
    const rows = [["a", "b", "c"]];
    for (let index = 0; index < 256; index += 1) {
      rows.push([
        atoms[index % atoms.length]!,
        atoms[(index * 3 + 1) % atoms.length]!,
        atoms[(index * 7 + 2) % atoms.length]!,
      ]);
    }
    const parsed = parseRecordsCsv(encodeCsv(rows));
    expect(parsed.headers).toEqual(rows[0]);
    expect(parsed.rows.map((row) => row.values)).toEqual(rows.slice(1));
  });

  it("enforces explicit row and column budgets", () => {
    expect(() => parseRecordsCsv("a,b\n1,2", { maxColumns: 1 })).toThrow(
      /exceeds 1 columns/i,
    );
    expect(() => parseRecordsCsv("a\n1\n2", { maxRows: 1 })).toThrow(
      /exceeds 1 data rows/i,
    );
  });
});

