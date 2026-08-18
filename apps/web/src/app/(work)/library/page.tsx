"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Share2 } from "lucide-react";
import PageHeading from "@/components/PageHeading";

type DocumentRow = {
  id: string;
  filename: string;
  relativePath: string;
  sizeBytes: number;
  status: string;
  skipReason: string | null;
  error: string | null;
  createdAt: string;
};

type ConceptRow = {
  id: string;
  path: string;
  type: string;
  title: string;
  description: string | null;
  body: string;
  status: string;
  sources: Array<{ resource: string }>;
  verified: Array<{ by: string; at: string }>;
  updatedAt: string;
};

type LibraryData = {
  documents: DocumentRow[];
  personal: ConceptRow[];
  team: ConceptRow[];
  pending: ConceptRow[];
};

async function fetchLibraryData(signal?: AbortSignal): Promise<LibraryData> {
  const response = await fetch("/api/library", { cache: "no-store", signal });
  if (!response.ok) throw new Error("Library could not be loaded.");
  const data = (await response.json()) as Partial<LibraryData>;
  return {
    documents: data.documents ?? [],
    personal: data.personal ?? [],
    team: data.team ?? [],
    pending: data.pending ?? [],
  };
}

export default function LibraryPage() {
  const [data, setData] = useState<LibraryData>({
    documents: [],
    personal: [],
    team: [],
    pending: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchLibraryData());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Library could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchLibraryData(controller.signal)
      .then((loaded) => {
        setData(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof Error ? cause.message : "Library could not be loaded.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const share = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const response = await fetch(
          `/api/library/concepts/${encodeURIComponent(id)}/share`,
          { method: "POST" },
        );
        if (!response.ok) throw new Error("Concept could not be shared.");
        await refresh();
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Concept could not be shared.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const decide = useCallback(
    async (id: string, action: "approve" | "decline") => {
      setBusyId(id);
      try {
        const response = await fetch(
          `/api/library/concepts/${encodeURIComponent(id)}/decide`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        if (!response.ok) throw new Error("Library review could not be saved.");
        await refresh();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Library review could not be saved.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const { documents, personal, team, pending } = data;

  return (
    <div className="library-page document-library">
      <PageHeading
        eyebrow="Knowledge"
        title="Library"
        actions={
          <div className="library-head-stats" aria-label="Library status">
            <div>
              <strong>{String(documents.length).padStart(2, "0")}</strong>
              <span>documents</span>
            </div>
            <div data-state={pending.length > 0 ? "attention" : "clear"}>
              <strong>{String(pending.length).padStart(2, "0")}</strong>
              <span>pending</span>
            </div>
          </div>
        }
      />

      <main className="library-main">
        {error ? (
          <div className="library-error" role="alert">
            <div>
              <strong>Library unavailable</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        ) : null}

        {pending.length > 0 ? (
          <section className="library-section memory-review">
            <header className="library-section-head">
              <div>
                <span>Review queue</span>
                <h2>Shared with the team</h2>
              </div>
              <strong>{String(pending.length).padStart(2, "0")}</strong>
            </header>
            <ol className="memory-review-list">
              {pending.map((concept, index) => (
                <li key={concept.id} className="memory-review-row">
                  <span className="library-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="memory-review-copy">
                    <div className="memory-review-meta">
                      <span>{concept.type}</span>
                      <span>{concept.path}</span>
                    </div>
                    <p>{concept.title}</p>
                    {concept.description ? <small>{concept.description}</small> : null}
                  </div>
                  <div className="memory-review-actions">
                    <button
                      type="button"
                      className="is-primary"
                      disabled={busyId === concept.id}
                      onClick={() => void decide(concept.id, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyId === concept.id}
                      onClick={() => void decide(concept.id, "decline")}
                    >
                      Decline
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="library-section">
          <header className="library-section-head">
            <div>
              <span>Uploads</span>
              <h2>Your documents</h2>
            </div>
            <strong>{String(documents.length).padStart(2, "0")}</strong>
          </header>
          {loading ? (
            <div className="library-loading" role="status" aria-label="Loading library">
              <span />
              <span />
              <span />
            </div>
          ) : documents.length === 0 ? (
            <div className="library-empty">
              <strong>No documents yet</strong>
              <span>
                Files you attach in a conversation are added here automatically
                and distilled into concepts the assistant can cite.
              </span>
            </div>
          ) : (
            <ol className="memory-review-list">
              {documents.map((doc, index) => (
                <li key={doc.id} className="memory-review-row">
                  <span className="library-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="memory-review-copy">
                    <div className="memory-review-meta">
                      <span>
                        <FileText aria-hidden="true" strokeWidth={2} size={12} />{" "}
                        {doc.filename}
                      </span>
                      <span>{formatSize(doc.sizeBytes)}</span>
                      <span>{formatDate(doc.createdAt)}</span>
                    </div>
                    {doc.status === "skipped" && doc.skipReason ? (
                      <small>{doc.skipReason}</small>
                    ) : null}
                    {doc.status === "failed" && doc.error ? (
                      <small>{doc.error}</small>
                    ) : null}
                  </div>
                  <div className="memory-review-actions">
                    <span data-status={doc.status}>{humanize(doc.status)}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="library-section">
          <header className="library-section-head">
            <div>
              <span>Personal layer</span>
              <h2>Your concepts</h2>
            </div>
            <strong>{String(personal.length).padStart(2, "0")}</strong>
          </header>
          {personal.length === 0 && !loading ? (
            <div className="library-empty">
              <strong>Nothing distilled yet</strong>
              <span>
                Concepts distilled from your documents appear here. Only you and
                your assistant can see them until you share one with the team.
              </span>
            </div>
          ) : (
            <ol className="memory-review-list">
              {personal.map((concept, index) => (
                <li key={concept.id} className="memory-review-row">
                  <span className="library-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="memory-review-copy">
                    <div className="memory-review-meta">
                      <span>{concept.type}</span>
                      <span>{concept.path}</span>
                      <span>{formatDate(concept.updatedAt)}</span>
                    </div>
                    <p>{concept.title}</p>
                    {concept.description ? <small>{concept.description}</small> : null}
                  </div>
                  <div className="memory-review-actions">
                    <button
                      type="button"
                      disabled={busyId === concept.id}
                      onClick={() => void share(concept.id)}
                    >
                      <Share2 aria-hidden="true" strokeWidth={2} size={12} /> Share
                      with team
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="library-section">
          <header className="library-section-head">
            <div>
              <span>Team layer</span>
              <h2>Team library</h2>
            </div>
            <strong>{String(team.length).padStart(2, "0")}</strong>
          </header>
          {team.length === 0 && !loading ? (
            <div className="library-empty">
              <strong>No approved team concepts</strong>
              <span>
                Concepts a teammate shares — and an admin approves — become part
                of the assistant&apos;s knowledge for the whole workspace.
              </span>
            </div>
          ) : (
            <ol className="memory-review-list">
              {team.map((concept, index) => (
                <li key={concept.id} className="memory-review-row">
                  <span className="library-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="memory-review-copy">
                    <div className="memory-review-meta">
                      <span>{concept.type}</span>
                      <span>{concept.path}</span>
                      {concept.verified.length > 0 ? (
                        <span>
                          verified {formatDate(concept.verified[concept.verified.length - 1].at)}
                        </span>
                      ) : null}
                    </div>
                    <p>{concept.title}</p>
                    {concept.description ? <small>{concept.description}</small> : null}
                  </div>
                  <div className="memory-review-actions">
                    <span data-status={concept.status}>{humanize(concept.status)}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </div>
  );
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", {
    month: "short",
    day: "numeric",
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
