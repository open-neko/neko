import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RecordFieldKind, RecordViewColumn } from "@neko/records";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { RecordForm } from "@/components/records/RecordForm";

function column(kind: RecordFieldKind, options: Partial<RecordViewColumn> = {}): RecordViewColumn {
  return {
    apiName: options.apiName ?? `${kind}_field`,
    columnName: options.columnName ?? `${kind}_field`,
    label: options.label ?? kind,
    kind,
    required: options.required ?? false,
    readOnly: options.readOnly ?? false,
    picklistValues: options.picklistValues ?? null,
    referenceTargets: options.referenceTargets ?? null,
    scale: options.scale ?? null,
  };
}

describe("RecordForm field matrix", () => {
  it("renders every editable kind, reference typeahead, and disabled formulas generically", () => {
    const fields = [
      column("text"),
      column("textarea"),
      column("boolean"),
      column("integer"),
      column("decimal", { scale: 2 }),
      column("currency", { scale: 2 }),
      column("percent", { scale: 1 }),
      column("date"),
      column("datetime"),
      column("email"),
      column("phone"),
      column("url"),
      column("picklist", { picklistValues: ["open", "closed"] }),
      column("multipicklist", { picklistValues: ["one", "two"] }),
      column("reference", { referenceTargets: ["account", "contact"] }),
      column("readonly_formula", { readOnly: true }),
    ];
    const html = renderToStaticMarkup(createElement(RecordForm, {
      appId: "crm",
      objectApiName: "opportunity",
      objectLabel: "Opportunity",
      operation: "create",
      fields,
    }));

    expect(html).toContain("<textarea");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="tel"');
    expect(html).toContain('type="url"');
    expect(html).toContain('type="date"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('step="0.01"');
    expect(html).toContain("multiple=\"\"");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("Search by record name or enter an ID");
    expect(html).toContain("account");
    expect(html).toContain("contact");
    expect(html).toMatch(/readonly_formula_field[^>]+disabled/);
    expect(html).toContain("shown for context only");
    expect(html).not.toContain('name="id"');
  });
});
