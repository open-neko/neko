export type CsvRecord = {
  /** One-based data-record ordinal; the header is record zero. */
  rowNumber: number;
  values: string[];
};

export type ParsedCsv = {
  headers: string[];
  rows: CsvRecord[];
};

export class RecordsCsvParseError extends Error {
  readonly code = "records_csv_invalid";

  constructor(
    message: string,
    readonly recordNumber: number,
    readonly columnNumber: number,
  ) {
    super(`${message} (record ${recordNumber}, column ${columnNumber})`);
    this.name = "RecordsCsvParseError";
  }
}

function assertHeaders(headers: string[]): string[] {
  if (headers.length === 0) {
    throw new RecordsCsvParseError("CSV header is missing", 1, 1);
  }
  const canonical = headers.map((header, index) => {
    const trimmed = header.trim();
    if (!trimmed) {
      throw new RecordsCsvParseError("CSV header cannot be empty", 1, index + 1);
    }
    if (trimmed.length > 500) {
      throw new RecordsCsvParseError("CSV header exceeds 500 characters", 1, index + 1);
    }
    return trimmed;
  });
  const seen = new Set<string>();
  for (const [index, header] of canonical.entries()) {
    const key = header.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new RecordsCsvParseError(`duplicate CSV header: ${header}`, 1, index + 1);
    }
    seen.add(key);
  }
  return canonical;
}

/**
 * Strict RFC-4180 parser with embedded-newline and escaped-quote support.
 * It intentionally returns records, not physical lines, so checkpoints stay
 * stable when a quoted field spans multiple lines.
 */
export function parseRecordsCsv(
  source: string,
  options: { maxRows?: number; maxColumns?: number } = {},
): ParsedCsv {
  const maxRows = options.maxRows ?? 1_000_000;
  const maxColumns = options.maxColumns ?? 1_000;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new Error("CSV maxRows must be a positive integer");
  }
  if (!Number.isSafeInteger(maxColumns) || maxColumns < 1) {
    throw new Error("CSV maxColumns must be a positive integer");
  }
  if (source.includes("\0")) {
    throw new RecordsCsvParseError("CSV cannot contain NUL bytes", 1, 1);
  }

  const input = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let recordNumber = 1;

  const pushField = () => {
    row.push(field);
    field = "";
    closedQuote = false;
    if (row.length > maxColumns) {
      throw new RecordsCsvParseError(
        `CSV exceeds ${maxColumns} columns`,
        recordNumber,
        row.length,
      );
    }
  };
  const pushRow = () => {
    pushField();
    records.push(row);
    row = [];
    recordNumber += 1;
    if (records.length - 1 > maxRows) {
      throw new RecordsCsvParseError(
        `CSV exceeds ${maxRows} data rows`,
        recordNumber,
        1,
      );
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (character === "\r") {
        if (input[index + 1] === "\n") {
          index += 1;
          field += "\n";
        } else {
          field += "\r";
        }
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new RecordsCsvParseError(
        "unexpected character after closing quote",
        recordNumber,
        row.length + 1,
      );
    }
    if (character === '"') {
      if (field.length > 0) {
        throw new RecordsCsvParseError(
          "quote must begin at the start of a field",
          recordNumber,
          row.length + 1,
        );
      }
      quoted = true;
    } else if (character === ",") {
      pushField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new RecordsCsvParseError(
      "unterminated quoted field",
      recordNumber,
      row.length + 1,
    );
  }
  if (field.length > 0 || row.length > 0 || closedQuote) pushRow();
  if (records.length === 0) {
    throw new RecordsCsvParseError("CSV is empty", 1, 1);
  }

  const headers = assertHeaders(records[0]!);
  const rows = records.slice(1).map((values, index): CsvRecord => {
    if (values.length !== headers.length) {
      throw new RecordsCsvParseError(
        `CSV record has ${values.length} fields; expected ${headers.length}`,
        index + 2,
        Math.min(values.length, headers.length) + 1,
      );
    }
    return { rowNumber: index + 1, values };
  });
  return { headers, rows };
}
