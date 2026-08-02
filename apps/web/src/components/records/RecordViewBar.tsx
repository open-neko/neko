import Link from "next/link";

function hrefWith(base: string, current: Record<string, string | undefined>, mine: boolean) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (value && key !== "after" && key !== "page") params.set(key, value);
  }
  if (mine) params.set("mine", "true");
  else params.delete("mine");
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function RecordViewBar({
  base,
  objectLabel,
  query,
  ownerScoped,
}: {
  base: string;
  objectLabel: string;
  query: Record<string, string | undefined>;
  ownerScoped: boolean;
}) {
  const mine = query.mine === "true";
  return (
    <div className="records-viewbar">
      <span className="records-view-name">All {objectLabel.toLowerCase()}</span>
      {query.q && (
        <span className="records-filter-chip">
          Name contains <b>{query.q}</b>
          <Link href={hrefWith(base, { ...query, q: undefined }, mine)} aria-label="Clear search">
            ×
          </Link>
        </span>
      )}
      <span className="records-filter-add" aria-disabled="true">+ Filter</span>
      {ownerScoped && (
        <Link
          href={hrefWith(base, query, !mine)}
          className="records-scope-toggle"
          role="switch"
          aria-checked={mine}
        >
          My records
          <span className={`records-switch${mine ? " is-on" : ""}`} aria-hidden="true">
            <span />
          </span>
        </Link>
      )}
    </div>
  );
}

