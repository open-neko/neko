"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CircleAlert, Link2, LoaderCircle, UserRoundX } from "lucide-react";
import { useState, type FormEvent } from "react";
import type {
  RecordIdentityAdminMapping,
  RecordIdentityAdminModel,
} from "@/lib/records-identity";

type IdentityStatus = RecordIdentityAdminMapping["status"];

const FILTERS: Array<{ value: IdentityStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "conflict", label: "Conflicts" },
  { value: "unlinked", label: "Unlinked" },
  { value: "linked", label: "Linked" },
  { value: "ignored", label: "Ignored" },
];

function userLabel(user: RecordIdentityAdminModel["users"][number]): string {
  return user.name ? `${user.name} · ${user.email}` : user.email;
}

function sourceLabel(mapping: RecordIdentityAdminMapping): string {
  return mapping.sourceName || mapping.sourceEmail;
}

function StatusIcon({ status }: { status: IdentityStatus }) {
  if (status === "linked") return <Check aria-hidden="true" />;
  if (status === "conflict") return <CircleAlert aria-hidden="true" />;
  if (status === "ignored") return <UserRoundX aria-hidden="true" />;
  return <Link2 aria-hidden="true" />;
}

function MappingControl({
  appId,
  mapping,
  users,
}: {
  appId: string;
  mapping: RecordIdentityAdminMapping;
  users: RecordIdentityAdminModel["users"];
}) {
  const router = useRouter();
  const [appUserId, setAppUserId] = useState(mapping.appUserId ?? "");
  const [pending, setPending] = useState<"link" | "ignore" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function decide(decision: "link" | "ignore") {
    if (decision === "link" && !appUserId) {
      setMessage("Choose a user first.");
      return;
    }
    setPending(decision);
    setMessage(null);
    try {
      const response = await fetch(`/api/a/${encodeURIComponent(appId)}/identity/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceInstanceId: mapping.sourceInstanceId,
          sourceUserId: mapping.sourceUserId,
          decision,
          ...(decision === "link" ? { appUserId } : {}),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(payload.error ?? "The identity could not be updated.");
        return;
      }
      router.refresh();
    } catch {
      setMessage("The identity service could not be reached.");
    } finally {
      setPending(null);
    }
  }

  return (
    <form
      className="records-identity-control"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void decide("link");
      }}
    >
      <select
        aria-label={`OpenNeko user for ${sourceLabel(mapping)}`}
        value={appUserId}
        onChange={(event) => setAppUserId(event.target.value)}
        disabled={pending !== null}
      >
        <option value="">Choose a user…</option>
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {userLabel(user)}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending !== null || !appUserId}>
        {pending === "link" ? <LoaderCircle className="records-spin" /> : <Link2 />}
        Link
      </button>
      <button
        className="is-quiet"
        type="button"
        disabled={pending !== null}
        onClick={() => void decide("ignore")}
      >
        {pending === "ignore" ? <LoaderCircle className="records-spin" /> : <UserRoundX />}
        Ignore
      </button>
      {message && <span role="alert">{message}</span>}
    </form>
  );
}

export function RecordIdentityPanel({
  appId,
  mappings,
  users,
  counts,
  activeFilter,
}: Pick<RecordIdentityAdminModel, "appId" | "mappings" | "users" | "counts"> & {
  activeFilter: IdentityStatus | "all";
}) {
  return (
    <div className="records-identity-layout">
      <nav className="records-identity-filters" aria-label="Identity status filters">
        {FILTERS.map((filter) => (
          <Link
            key={filter.value}
            className={activeFilter === filter.value ? "is-active" : undefined}
            href={
              filter.value === "all"
                ? `/a/${appId}/admin/identity`
                : `/a/${appId}/admin/identity?status=${filter.value}`
            }
          >
            {filter.label}
            <span>{counts[filter.value]}</span>
          </Link>
        ))}
      </nav>

      <section className="records-identity-card" aria-label="Source identity mappings">
        <header>
          <div>
            <h2>Source identities</h2>
            <p>
              Links are scoped to this app and source instance. Resolve conflicts before
              ownership is backfilled.
            </p>
          </div>
          <span>{mappings.length.toLocaleString("en")} shown</span>
        </header>
        <div className="records-identity-scroll">
          <table className="records-identity-table">
            <thead>
              <tr>
                <th>Source user</th>
                <th>Source</th>
                <th>Status</th>
                <th>OpenNeko user</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping) => (
                <tr key={`${mapping.sourceInstanceId}\u0000${mapping.sourceUserId}`}>
                  <td>
                    <strong>{sourceLabel(mapping)}</strong>
                    {mapping.sourceName && <small>{mapping.sourceEmail}</small>}
                    <small>{mapping.sourceUserId}</small>
                  </td>
                  <td>
                    <code>{mapping.sourceInstanceId}</code>
                    {mapping.sourceIsActive === false && <small>Inactive at source</small>}
                  </td>
                  <td>
                    <span className={`records-identity-status is-${mapping.status}`}>
                      <StatusIcon status={mapping.status} />
                      {mapping.status}
                    </span>
                  </td>
                  <td>
                    {mapping.appUser ? (
                      <>
                        <strong>{mapping.appUser.name ?? mapping.appUser.email}</strong>
                        {mapping.appUser.name && <small>{mapping.appUser.email}</small>}
                      </>
                    ) : mapping.appUserId ? (
                      <>
                        <strong>Unavailable user</strong>
                        <small>{mapping.appUserId}</small>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <MappingControl appId={appId} mapping={mapping} users={users} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mappings.length === 0 && (
          <div className="records-empty">
            <strong>No identities in this view</strong>
            <span>Try another status, or run a source import first.</span>
          </div>
        )}
      </section>
    </div>
  );
}
