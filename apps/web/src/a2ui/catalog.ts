/**
 * A2UI Component Catalog
 *
 * The pre-approved components an agent may compose into a web answer surface —
 * briefings AND conversational answers share this one vocabulary. Display
 * components (Markdown, Table, Callout, BriefingCard) plus layout (Section,
 * Divider) plus the interactive Choice, which round-trips a follow-up back to
 * the agent via the A2UI action loop.
 *
 * All property values support A2UI data binding via { path: "/..." }
 */

export const CATALOG_ID = "urn:app:catalog:briefing:v1";

// Component type names agents can reference. "Briefing" is the dashboard's
// daily-briefing root; the conversational work/Ask surface uses "Answer". Both
// render the same frame, so MetricCard is the neutral name for the KPI card in
// an Answer (BriefingCard stays for the dashboard + already-stored surfaces).
export const ComponentTypes = {
  Answer: "Answer",
  MetricCard: "MetricCard",
  Confirmation: "Confirmation",
  Markdown: "Markdown",
  Table: "Table",
  Section: "Section",
  Callout: "Callout",
  Choice: "Choice",
  Divider: "Divider",
  // Dashboard / back-compat aliases (same renderers):
  Briefing: "Briefing",
  BriefingCard: "BriefingCard",
} as const;

// Mood enum shared across components
export type Mood = "good" | "watch" | "act";

// Chart type enum — 5 types cover 92% of exec needs
export type ChartType = "kpi" | "line" | "bar" | "area" | "donut";

// Chart data point
export interface ChartDataPoint {
  d: string;  // label (e.g. day name)
  v: number;  // primary value
  t?: number; // secondary/comparison value
}

// --- Component Property Schemas ---

export interface BriefingProps {
  component: "Briefing";
  greeting: string;
  subtitle: string;
  role: string;
  isExample?: boolean; // true when cards are the legacy ROLE_DATA mock
  children: string[]; // IDs of BriefingCard components
}

// The conversational answer root (work/Ask). Same frame as Briefing, but no
// dashboard "Briefing" framing — an optional `eyebrow` kicker instead.
export interface AnswerProps {
  component: "Answer";
  title: string;
  subtitle?: string;
  eyebrow?: string;
  children: string[]; // ids of body components, in display order
}

export interface MarkdownProps {
  component: "Markdown";
  text: string;
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
}

export interface TableProps {
  component: "Table";
  columns: TableColumn[];
  rows: Record<string, string | number>[];
  caption?: string;
}

export interface SectionProps {
  component: "Section";
  title: string;
  collapsible?: boolean; // render as a native <details> disclosure
  defaultOpen?: boolean; // open state when collapsible (default true)
  children: string[];    // ids of body components
}

export interface CalloutProps {
  component: "Callout";
  mood: Mood;        // tints the left rail + background
  title?: string;
  text: string;      // markdown body
}

export interface ChoiceOption {
  label: string;     // button text
  prompt: string;    // the follow-up turn sent to the agent when clicked
  mood?: Mood;
}

// Interactive: each option, when clicked, fires an A2UI action that submits
// `prompt` as the next turn — the in-answer drill-down / follow-up loop.
export interface ChoiceProps {
  component: "Choice";
  options: ChoiceOption[];
}

export interface DividerProps {
  component: "Divider";
  label?: string;
}

export interface ConfirmationProps {
  component: "Confirmation";
  label: string; // action eyebrow, e.g. "Created workflow"
  title: string; // the saved entity's name
  children: string[]; // IDs of body components (typically a Markdown)
}

export interface BriefingCardProps {
  component: "BriefingCard";
  metricId: string;   // DB UUID — needed for pin/dashboard API calls
  source: string;     // "bootstrap" | "chat"
  state?: "ok" | "pending" | "failed"; // discriminator for the card chrome
  error?: string;     // populated when state="failed"
  mood: Mood;
  text: string;       // headline
  metric: string;     // e.g. "$4.7M"
  label: string;      // e.g. "Revenue MTD"
  detail: string;     // expanded explanation
  chartType: ChartType;
  chartData: ChartDataPoint[];
}

// The KPI card as named in a work/Ask Answer — identical shape to BriefingCard,
// which stays the dashboard's name and renders through the same component.
export type MetricCardProps = Omit<BriefingCardProps, "component"> & {
  component: "MetricCard";
};

// Union of all component props
export type ComponentProps =
  | AnswerProps
  | BriefingProps
  | MetricCardProps
  | BriefingCardProps
  | ConfirmationProps
  | MarkdownProps
  | TableProps
  | SectionProps
  | CalloutProps
  | ChoiceProps
  | DividerProps;
