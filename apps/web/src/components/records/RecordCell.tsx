import Link from "next/link";
import type { RecordViewColumn } from "@neko/records";
import type { RecordOwnerIdentity } from "@/lib/records";
import type { RecordReferenceIdentity } from "@/lib/records-reference";

const PILL_TONES = ["violet", "green", "amber", "blue", "rose", "slate"] as const;
type PillTone = (typeof PILL_TONES)[number];

function stableTone(value: string): PillTone {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return PILL_TONES[Math.abs(hash) % PILL_TONES.length] ?? "slate";
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function picklistPresentation(
  column: RecordViewColumn,
  value: string,
): { label: string; tone: PillTone; emphasis: boolean } {
  for (const option of column.picklistValues ?? []) {
    if (typeof option === "string" && option === value) {
      return { label: option, tone: stableTone(value), emphasis: false };
    }
    if (option && typeof option === "object" && !Array.isArray(option)) {
      const candidate = option as Record<string, unknown>;
      if (candidate.value === value) {
        const tone =
          typeof candidate.color === "string" &&
          (PILL_TONES as readonly string[]).includes(candidate.color)
            ? candidate.color as PillTone
            : stableTone(value);
        return {
          label: typeof candidate.label === "string" ? candidate.label : value,
          tone,
          emphasis:
            candidate.emphasis === true || candidate.emphasis === "strong",
        };
      }
    }
  }
  return { label: value, tone: stableTone(value), emphasis: false };
}

function PicklistPill({ column, value }: { column: RecordViewColumn; value: string }) {
  const presentation = picklistPresentation(column, value);
  return (
    <span
      className={`records-pill is-${presentation.tone}${presentation.emphasis ? " is-emphasis" : ""}`}
    >
      {presentation.label}
    </span>
  );
}

function DateValue({ value, includeTime }: { value: unknown; includeTime: boolean }) {
  const date = new Date(text(value));
  if (Number.isNaN(date.getTime())) return <span className="records-null">—</span>;
  const absolute = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    ...(includeTime ? { timeStyle: "short" as const } : {}),
  }).format(date);
  // Relative labels are presentation-only and intentionally use the render
  // instant; the absolute timestamp remains canonical in dateTime/title.
  // eslint-disable-next-line react-hooks/purity
  const ageDays = Math.round((Date.now() - date.getTime()) / 86_400_000);
  const relative =
    Math.abs(ageDays) <= 7
      ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-ageDays, "day")
      : null;
  return (
    <time className="records-date" dateTime={date.toISOString()} title={absolute}>
      {relative ?? absolute}
    </time>
  );
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function NumberValue({ column, value }: { column: RecordViewColumn; value: unknown }) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return <span className="records-null">—</span>;
  const scale = Math.min(Math.max(column.scale ?? (column.kind === "currency" ? 2 : 0), 0), 10);
  const formatted = new Intl.NumberFormat("en", {
    ...(column.kind === "currency"
      ? { style: "currency" as const, currency: "USD" }
      : {}),
    minimumFractionDigits: column.kind === "integer" ? 0 : scale,
    maximumFractionDigits: scale,
  }).format(numeric);
  return (
    <span className="records-number">
      {formatted}
      {column.kind === "percent" ? "%" : ""}
    </span>
  );
}

function OwnerValue({ ownerId, owner }: { ownerId: string; owner?: RecordOwnerIdentity }) {
  const label = owner?.label ?? ownerId;
  const initials = label
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  const unresolved = !owner || owner.status === "unlinked" || owner.status === "conflict";
  return (
    <span className="records-owner" title={owner?.email ?? ownerId}>
      <span className={`records-owner-avatar${unresolved ? " is-unlinked" : ""}`}>
        {initials || "?"}
      </span>
      <span className="records-owner-label">{label}</span>
      {unresolved && (
        <span className="records-owner-flag">
          {owner?.status === "conflict" ? "Conflict" : "Unlinked"}
        </span>
      )}
    </span>
  );
}

export function RecordCell({
  appId,
  column,
  value,
  owner,
  reference,
  linkify = true,
}: {
  appId: string;
  column: RecordViewColumn;
  value: unknown;
  owner?: RecordOwnerIdentity;
  reference?: RecordReferenceIdentity;
  linkify?: boolean;
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="records-null">—</span>;
  }
  if (column.kind === "owner") {
    return <OwnerValue ownerId={text(value)} owner={owner} />;
  }
  if (column.kind === "boolean") {
    return <span className="records-boolean">{value === true ? "Yes" : "No"}</span>;
  }
  if (["integer", "decimal", "currency", "percent"].includes(column.kind)) {
    return <NumberValue column={column} value={value} />;
  }
  if (column.kind === "date") return <DateValue value={value} includeTime={false} />;
  if (column.kind === "datetime" || column.kind === "system_datetime") {
    return <DateValue value={value} includeTime />;
  }
  if (column.kind === "picklist") {
    return <PicklistPill column={column} value={text(value)} />;
  }
  if (column.kind === "multipicklist") {
    let values: unknown[] = [];
    if (Array.isArray(value)) values = value;
    else if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        values = Array.isArray(parsed) ? parsed : [value];
      } catch {
        values = [value];
      }
    }
    return (
      <span className="records-pill-row">
        {values.slice(0, 2).map((item, index) => (
          <PicklistPill key={`${text(item)}-${index}`} column={column} value={text(item)} />
        ))}
        {values.length > 2 && <span className="records-pill-more">+{values.length - 2}</span>}
      </span>
    );
  }
  const valueText = text(value);
  if (linkify && column.kind === "email") {
    return <a href={`mailto:${valueText}`}>{valueText}</a>;
  }
  if (linkify && column.kind === "phone") {
    return <a href={`tel:${valueText}`}>{valueText}</a>;
  }
  if (linkify && column.kind === "url") {
    const url = safeHttpUrl(valueText);
    if (url) {
      return (
        <a href={url} target="_blank" rel="noreferrer">
          {valueText}
        </a>
      );
    }
  }
  if (column.kind === "reference") {
    const target = reference?.objectApiName ??
      (column.referenceTargets?.length === 1 ? column.referenceTargets[0] : null);
    const label = reference?.label ?? valueText;
    return linkify && target ? (
      <Link href={`/a/${appId}/${target}/${encodeURIComponent(valueText)}`}>
        {label}
      </Link>
    ) : <span>{label}</span>;
  }
  return <span className={column.kind === "readonly_formula" ? "records-readonly" : undefined}>{valueText}</span>;
}
