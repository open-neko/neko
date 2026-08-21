import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, IconButton } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { FieldInput } from "@/components/ui/Field";
import { Segment, SegmentedControl, Tab, Tabs } from "@/components/ui/Tabs";

describe("shared UI contracts", () => {
  it("keeps button hierarchy and icon actions machine-readable", () => {
    const primary = renderToStaticMarkup(
      createElement(Button, { variant: "primary", size: "lg" }, "Continue"),
    );
    expect(primary).toContain('data-ui-button=""');
    expect(primary).toContain('data-variant="primary"');
    expect(primary).toContain('data-size="lg"');
    expect(primary).toContain('type="button"');

    const icon = renderToStaticMarkup(
      createElement(
        IconButton,
        { label: "More actions" } as Parameters<typeof IconButton>[0],
        "…",
      ),
    );
    expect(icon).toContain('aria-label="More actions"');
    expect(icon).toContain('title="More actions"');
  });

  it("exposes selection state consistently for tabs and segments", () => {
    const tabs = renderToStaticMarkup(
      createElement(
        Tabs,
        null,
        createElement(Tab, { selected: true }, "Overview"),
      ),
    );
    expect(tabs).toContain('role="tablist"');
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain('data-ui-tab=""');

    const segments = renderToStaticMarkup(
      createElement(
        SegmentedControl,
        null,
        createElement(Segment, { selected: true }, "Active"),
      ),
    );
    expect(segments).toContain('aria-pressed="true"');
    expect(segments).toContain('data-ui-segment=""');
  });

  it("preserves labelled fields and native disclosure semantics", () => {
    const field = renderToStaticMarkup(
      createElement(FieldInput, {
        id: "workspace-name",
        label: "Workspace name",
      }),
    );
    expect(field).toContain('for="workspace-name"');
    expect(field).toContain('id="workspace-name"');
    expect(field).toContain('data-ui-field-control=""');

    const disclosure = renderToStaticMarkup(
      createElement(Disclosure, { title: "Advanced" }, "Details"),
    );
    expect(disclosure).toContain("<details");
    expect(disclosure).toContain("<summary");
    expect(disclosure).toContain('data-ui-disclosure=""');
  });
});
