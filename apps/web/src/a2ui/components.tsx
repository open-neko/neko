"use client";

/**
 * Neko Component Registrations
 *
 * Registers React renderers for each A2UI component type
 * in the Neko catalog. Import this module once at app startup
 * to populate the registry.
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  WORKSPACE_MARKDOWN_COMPONENTS,
  linkifyWorkspacePaths,
} from "@/lib/linkify-workspace-paths";
import { registerComponent, renderChildren } from "./renderer";
import { bodyChildIds } from "./surface";
import type { RenderContext } from "./renderer";
import type { A2UIComponent } from "./types";
import type {
  AnswerProps,
  BriefingCardProps,
  BriefingProps,
  CalloutProps,
  ChoiceProps,
  ConfirmationProps,
  DividerProps,
  MarkdownProps,
  SectionProps,
  TableProps,
} from "./catalog";
import BriefingCard from "@/components/BriefingCard";

// ─── Answer / Briefing root ───
// The card frame for a conversational answer (Answer) and the dashboard's daily
// briefing (Briefing). Thread-scale header — the dashboard's hero classes
// (.greet, 52px) would overwhelm an answer, so this mirrors the eyebrow +
// display-title language at card proportions. `eyebrow` is optional: the
// dashboard passes "Briefing", an Answer passes its own kicker or none.
function surfaceFrame(
  opts: { id: string; eyebrow?: string; title?: string; subtitle?: string; childIds: string[] },
  ctx: RenderContext,
) {
  return (
    <div key={opts.id} className="work-surface">
      {opts.eyebrow ? (
        <div className="work-surface-eyebrow" style={{ animation: "fadeUp 0.5s ease both" }}>
          <span className="work-surface-eyebrow-rule" aria-hidden="true" />
          {opts.eyebrow}
        </div>
      ) : null}
      {opts.title ? (
        <div className="work-surface-title" style={{ animation: "fadeUp 0.5s ease 0.04s both" }}>
          {opts.title}
        </div>
      ) : null}
      {opts.subtitle ? (
        <div className="work-surface-sub" style={{ animation: "fadeUp 0.5s ease 0.08s both" }}>
          {opts.subtitle}
        </div>
      ) : null}
      {opts.childIds.length > 0 ? renderChildren(opts.childIds, ctx) : null}
    </div>
  );
}

registerComponent("Answer", (comp: A2UIComponent, ctx: RenderContext) => {
  const props = comp as unknown as AnswerProps & { id: string };
  return surfaceFrame(
    { id: props.id, eyebrow: props.eyebrow, title: props.title, subtitle: props.subtitle, childIds: bodyChildIds(ctx.surface, comp) },
    ctx,
  );
});

registerComponent("Briefing", (comp: A2UIComponent, ctx: RenderContext) => {
  const props = comp as unknown as BriefingProps & { id: string };
  return surfaceFrame(
    { id: props.id, eyebrow: "Briefing", title: props.greeting, subtitle: props.subtitle, childIds: bodyChildIds(ctx.surface, comp) },
    ctx,
  );
});

// ─── Confirmation ───
registerComponent("Confirmation", (comp: A2UIComponent, ctx: RenderContext) => {
  const props = comp as unknown as ConfirmationProps & { id: string };
  return (
    <div
      key={props.id}
      className="work-confirm"
      style={{ animation: "fadeUp 0.4s ease both" }}
    >
      <div className="work-confirm-head">
        <span className="work-confirm-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
        <span className="work-confirm-label">{props.label}</span>
      </div>
      {props.title ? <div className="work-confirm-title">{props.title}</div> : null}
      {props.children ? (
        <div className="work-confirm-body">{renderChildren(props.children, ctx)}</div>
      ) : null}
    </div>
  );
});

// ─── Markdown ───
registerComponent("Markdown", (comp: A2UIComponent) => {
  const props = comp as unknown as MarkdownProps & { id: string };
  return (
    <div key={props.id} className="work-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={WORKSPACE_MARKDOWN_COMPONENTS}
      >
        {linkifyWorkspacePaths(props.text)}
      </ReactMarkdown>
    </div>
  );
});

// ─── MetricCard / BriefingCard ───
// One KPI card, two names: MetricCard in a work/Ask Answer, BriefingCard on the
// dashboard (and in already-stored surfaces). Same renderer.
const renderMetricCard = (comp: A2UIComponent, ctx: RenderContext) => {
  const props = comp as unknown as BriefingCardProps & { id: string };
  const extras = ctx.extras as {
    onDismiss?: (id: string) => void;
    indexMap?: Map<string, number>;
  } | undefined;

  const index = extras?.indexMap?.get(props.id) ?? 0;

  const insight = {
    id: props.id,
    metricId: props.metricId,
    source: props.source,
    mood: props.mood,
    text: props.text,
    metric: props.metric,
    label: props.label,
    detail: props.detail,
    chart: props.chartType,
    chartData: props.chartData,
  };

  return (
    <BriefingCard
      key={props.id}
      ins={insight}
      index={index}
      onDismiss={extras?.onDismiss ? () => extras.onDismiss?.(props.id) : undefined}
    />
  );
};
registerComponent("MetricCard", renderMetricCard);
registerComponent("BriefingCard", renderMetricCard);

// ─── Table ───
// Structured tabular data. Tables used to only exist as Markdown GFM, which
// can't carry alignment or survive a non-web channel; this is a first-class
// component the agent addresses by columns + rows.
registerComponent("Table", (comp: A2UIComponent) => {
  const props = comp as unknown as TableProps & { id: string };
  const columns = Array.isArray(props.columns) ? props.columns : [];
  const rows = Array.isArray(props.rows) ? props.rows : [];
  return (
    <div key={props.id} className="work-table-wrap">
      {props.caption ? <div className="work-table-caption">{props.caption}</div> : null}
      <table className="work-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={col.align ? { textAlign: col.align } : undefined}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {columns.map((col) => (
                <td key={col.key} style={col.align ? { textAlign: col.align } : undefined}>
                  {String(row[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

// ─── Section ───
// A titled group of components. `collapsible` renders a native <details> so
// long answers can fold their supporting detail without any client state.
registerComponent("Section", (comp: A2UIComponent, ctx: RenderContext) => {
  const props = comp as unknown as SectionProps & { id: string };
  const childIds = Array.isArray(props.children) ? props.children : [];
  const body = <div className="work-section-body">{renderChildren(childIds, ctx)}</div>;
  if (props.collapsible) {
    return (
      <details key={props.id} className="work-section is-collapsible" open={props.defaultOpen !== false}>
        <summary className="work-section-summary">{props.title}</summary>
        {body}
      </details>
    );
  }
  return (
    <div key={props.id} className="work-section">
      <div className="work-section-title">{props.title}</div>
      {body}
    </div>
  );
});

// ─── Callout ───
// Mood-tinted prose block (markdown body). Distinct from BriefingCard: it
// carries an argument, not a KPI tile.
registerComponent("Callout", (comp: A2UIComponent) => {
  const props = comp as unknown as CalloutProps & { id: string };
  const mood = props.mood ?? "watch";
  return (
    <div key={props.id} className={`work-callout work-callout-${mood}`}>
      {props.title ? <div className="work-callout-title">{props.title}</div> : null}
      <div className="work-callout-body work-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={WORKSPACE_MARKDOWN_COMPONENTS}>
          {linkifyWorkspacePaths(props.text)}
        </ReactMarkdown>
      </div>
    </div>
  );
});

// ─── Choice ───
// Interactive: each option submits its `prompt` as the next turn via the A2UI
// action loop (ctx.onAction → the work screen's follow-up sender). This is what
// turns a static answer into a drill-down.
registerComponent("Choice", (comp: A2UIComponent, ctx: RenderContext) => {
  const props = comp as unknown as ChoiceProps & { id: string };
  const options = Array.isArray(props.options) ? props.options : [];
  return (
    <div key={props.id} className="work-choice">
      {options.map((opt, i) => (
        <button
          key={i}
          type="button"
          className="work-choice-btn"
          data-mood={opt.mood ?? undefined}
          onClick={() =>
            ctx.onAction?.(props.id, "select", { prompt: opt.prompt, value: opt.label })
          }
        >
          <span>{opt.label}</span>
          <span className="work-choice-arrow" aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  );
});

// ─── Divider ───
registerComponent("Divider", (comp: A2UIComponent) => {
  const props = comp as unknown as DividerProps & { id: string };
  if (props.label) {
    return (
      <div key={props.id} className="work-divider is-labeled">
        <span>{props.label}</span>
      </div>
    );
  }
  return <hr key={props.id} className="work-divider" />;
});
