"use client";

import Link from "next/link";
import {
  Ban,
  CheckCircle2,
  FileSpreadsheet,
  LoaderCircle,
  LockKeyhole,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { RecordImportPlan } from "@neko/records";
import type {
  RecordImportAdminObject,
  RecordImportRunSummary,
} from "@/lib/records-imports";

type ApiResponse = {
  error?: string;
  plan?: RecordImportPlan;
  status?: "executed" | "queued";
  actionRequestId?: string;
  importRunId?: string | null;
  run?: RecordImportRunSummary;
};

function statusLabel(status: RecordImportRunSummary["status"]): string {
  return status === "succeeded"
    ? "Complete"
    : status === "cancelled"
      ? "Cancelled"
      : status[0]!.toUpperCase() + status.slice(1);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function RecordImportPanel({
  appId,
  objects,
  recentRuns,
  initialObject,
}: {
  appId: string;
  objects: RecordImportAdminObject[];
  recentRuns: RecordImportRunSummary[];
  initialObject?: string;
}) {
  const firstObject =
    objects.find((object) => object.apiName === initialObject)?.apiName ??
    objects[0]?.apiName ??
    "";
  const [objectApiName, setObjectApiName] = useState(firstObject);
  const [plan, setPlan] = useState<RecordImportPlan | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [duplicateKey, setDuplicateKey] = useState("id");
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionRequestId, setActionRequestId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<RecordImportRunSummary | null>(null);

  const selectedObject = useMemo(
    () => objects.find((object) => object.apiName === objectApiName) ?? null,
    [objectApiName, objects],
  );
  const duplicateOptions = useMemo(
    () =>
      ["id", ...Object.values(mapping).filter((value): value is string => Boolean(value))]
        .filter((value, index, all) => all.indexOf(value) === index),
    [mapping],
  );
  const activeRunId = activeRun?.id;
  const activeRunStatus = activeRun?.status;

  useEffect(() => {
    if (!activeRunId || !activeRunStatus || !["planned", "running"].includes(activeRunStatus)) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/a/${encodeURIComponent(appId)}/imports/${encodeURIComponent(activeRunId)}`,
          { cache: "no-store" },
        );
        const payload = (await response.json()) as ApiResponse;
        if (!cancelled && response.ok && payload.run) setActiveRun(payload.run);
      } catch {
        // Keep the last authoritative status visible and retry on the next tick.
      }
    };
    void poll();
    const timer = setInterval(poll, 1_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRunId, activeRunStatus, appId]);

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreviewing(true);
    setMessage(null);
    setActionRequestId(null);
    setPlan(null);
    const body = new FormData(event.currentTarget);
    body.set("object", objectApiName);
    try {
      const response = await fetch(`/api/a/${encodeURIComponent(appId)}/imports/preview`, {
        method: "POST",
        body,
      });
      const payload = (await response.json()) as ApiResponse;
      if (!response.ok || !payload.plan) {
        setMessage(payload.error ?? "The CSV could not be inspected.");
        return;
      }
      setPlan(payload.plan);
      setMapping(
        Object.fromEntries(
          payload.plan.columns.map((column) => [column.sourceColumn, column.targetField]),
        ),
      );
      setDuplicateKey(payload.plan.duplicateKey);
    } catch {
      setMessage("The import service could not be reached.");
    } finally {
      setPreviewing(false);
    }
  }

  function changeMapping(sourceColumn: string, target: string) {
    const value = target || null;
    setMapping((current) => ({ ...current, [sourceColumn]: value }));
    if (duplicateKey !== "id" && duplicateKey === mapping[sourceColumn] && value !== duplicateKey) {
      setDuplicateKey("id");
    }
  }

  async function startImport() {
    if (!plan) return;
    setStarting(true);
    setMessage(null);
    setActionRequestId(null);
    try {
      const response = await fetch(`/api/a/${encodeURIComponent(appId)}/imports/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          object: plan.objectApiName,
          sourcePath: plan.source.path,
          sourceName: plan.source.name,
          mapping,
          duplicateKey,
          batchSize: plan.batchSize,
        }),
      });
      const payload = (await response.json()) as ApiResponse;
      setActionRequestId(payload.actionRequestId ?? null);
      if (!response.ok) {
        setMessage(payload.error ?? "The governed import could not be started.");
        return;
      }
      if (!payload.importRunId) {
        setMessage(
          "The start action is queued. No import was assumed; follow the action request for its durable run ID.",
        );
        return;
      }
      const statusResponse = await fetch(
        `/api/a/${encodeURIComponent(appId)}/imports/${encodeURIComponent(payload.importRunId)}`,
        { cache: "no-store" },
      );
      const statusPayload = (await statusResponse.json()) as ApiResponse;
      if (statusResponse.ok && statusPayload.run) setActiveRun(statusPayload.run);
      setMessage("The approved import is running in the worker.");
    } catch {
      setMessage("The import service could not be reached. No success was assumed.");
    } finally {
      setStarting(false);
    }
  }

  async function openRun(id: string) {
    setMessage(null);
    try {
      const response = await fetch(
        `/api/a/${encodeURIComponent(appId)}/imports/${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as ApiResponse;
      if (response.ok && payload.run) setActiveRun(payload.run);
      else setMessage(payload.error ?? "The import run could not be loaded.");
    } catch {
      setMessage("The import status service could not be reached.");
    }
  }

  async function cancelImport() {
    if (!activeRun) return;
    setCancelling(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/a/${encodeURIComponent(appId)}/imports/${encodeURIComponent(activeRun.id)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as ApiResponse;
      setActionRequestId(payload.actionRequestId ?? null);
      setMessage(
        response.ok
          ? "Cancellation was approved. The worker will stop at a batch boundary."
          : payload.error ?? "The import could not be cancelled.",
      );
    } catch {
      setMessage("The cancellation service could not be reached.");
    } finally {
      setCancelling(false);
    }
  }

  const progress = activeRun?.progress;
  const report = activeRun?.report;
  const processed = count(progress?.processed);
  const total = count(progress?.total) || activeRun?.sourceRows || 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  return (
    <div className="records-import-layout">
      <section className="records-import-main">
        <form className="records-import-upload" onSubmit={preview}>
          <div>
            <span className="records-eyebrow">Step 1 · Inspect</span>
            <h2>Choose a destination and CSV</h2>
            <p>The file is staged privately, parsed as RFC-4180, and hashed before review.</p>
          </div>
          <label>
            Destination object
            <select
              name="object"
              value={objectApiName}
              onChange={(event) => {
                setObjectApiName(event.target.value);
                setPlan(null);
              }}
            >
              {objects.map((object) => (
                <option value={object.apiName} key={object.apiName}>
                  {object.pluralLabel}
                </option>
              ))}
            </select>
          </label>
          <label>
            CSV file
            <input name="file" type="file" accept=".csv,text/csv" required />
          </label>
          <button className="records-primary-action" type="submit" disabled={previewing || !objectApiName}>
            {previewing ? <LoaderCircle className="records-spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
            {previewing ? "Inspecting…" : "Review mapping"}
          </button>
        </form>

        {plan && selectedObject && (
          <section className="records-import-review">
            <header>
              <div>
                <span className="records-eyebrow">Step 2 · Review</span>
                <h2>{plan.source.name}</h2>
                <p>
                  {plan.rowCount.toLocaleString("en")} rows · {plan.columns.length} columns · SHA-256 {plan.source.sha256.slice(0, 12)}…
                </p>
              </div>
              <FileSpreadsheet aria-hidden="true" />
            </header>
            <div className="records-import-mapping-scroll">
              <table className="records-import-mapping">
                <thead>
                  <tr>
                    <th>CSV column</th>
                    <th>Sample</th>
                    <th>Detected</th>
                    <th>Destination field</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.columns.map((column) => (
                    <tr key={column.sourceColumn}>
                      <td>{column.sourceColumn}</td>
                      <td>{plan.sampleRows[0]?.[column.sourceColumn] || <span className="records-null">Empty</span>}</td>
                      <td><span className="records-import-kind">{column.inferredKind}</span></td>
                      <td>
                        <select
                          value={mapping[column.sourceColumn] ?? ""}
                          onChange={(event) => changeMapping(column.sourceColumn, event.target.value)}
                          aria-label={`Destination for ${column.sourceColumn}`}
                        >
                          <option value="">Ignore this column</option>
                          <option value="id">Record ID</option>
                          {selectedObject.fields.map((field) => (
                            <option value={field.apiName} key={field.apiName}>
                              {field.label}{field.required ? " · required" : ""}
                            </option>
                          ))}
                        </select>
                        {!mapping[column.sourceColumn] && column.suggestedField && (
                          <small>
                            Suggested new field: {column.suggestedField.label} ({column.suggestedField.kind}); ignored until added to the schema.
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="records-import-review-footer">
              <label>
                Duplicate key
                <select value={duplicateKey} onChange={(event) => setDuplicateKey(event.target.value)}>
                  {duplicateOptions.map((field) => (
                    <option value={field} key={field}>{field === "id" ? "Record ID" : field}</option>
                  ))}
                </select>
              </label>
              <p>
                <LockKeyhole aria-hidden="true" /> Insert-only. Existing keys are reported, never overwritten.
              </p>
              <button className="records-primary-action" type="button" onClick={startImport} disabled={starting}>
                {starting ? <LoaderCircle className="records-spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                {starting ? "Approving…" : `Approve and import ${plan.rowCount.toLocaleString("en")} rows`}
              </button>
            </footer>
          </section>
        )}

        {message && (
          <div className="records-form-message" role="status">
            <span>{message}</span>
            {actionRequestId && <Link href={`/actions/${actionRequestId}`}>View action request</Link>}
          </div>
        )}
      </section>

      <aside className="records-import-side">
        {activeRun ? (
          <section className="records-import-status">
            <header>
              <span className={`records-import-status-dot is-${activeRun.status}`} />
              <div>
                <span className="records-eyebrow">Import status</span>
                <h2>{statusLabel(activeRun.status)}</h2>
              </div>
            </header>
            <strong>{activeRun.sourceName}</strong>
            <span>{activeRun.objectApiName} · {activeRun.sourceRows.toLocaleString("en")} source rows</span>
            {activeRun.status === "running" && (
              <div className="records-import-progress">
                <div><span style={{ width: `${percent}%` }} /></div>
                <small>{processed.toLocaleString("en")} of {total.toLocaleString("en")} processed</small>
              </div>
            )}
            {(activeRun.status === "succeeded" || activeRun.status === "cancelled") && (
              <dl className="records-import-report">
                <div><dt>Inserted</dt><dd>{count(report?.inserted).toLocaleString("en")}</dd></div>
                <div><dt>Not inserted</dt><dd>{count(report?.rejected).toLocaleString("en")}</dd></div>
                <div><dt>Duplicates</dt><dd>{count(report?.duplicates).toLocaleString("en")}</dd></div>
              </dl>
            )}
            {activeRun.error && (
              <p className="records-import-error">{String(activeRun.error.message ?? "Import failed.")}</p>
            )}
            {["planned", "running"].includes(activeRun.status) && (
              <button className="records-import-cancel" type="button" onClick={cancelImport} disabled={cancelling}>
                {cancelling ? <LoaderCircle className="records-spin" aria-hidden="true" /> : <Ban aria-hidden="true" />}
                {cancelling ? "Cancelling…" : "Cancel at batch boundary"}
              </button>
            )}
          </section>
        ) : (
          <section className="records-import-principles">
            <LockKeyhole aria-hidden="true" />
            <h2>One approval, durable batches</h2>
            <p>Rows move through the service-only GraphJin path. Every committed batch carries an audit entry and a same-transaction receipt.</p>
          </section>
        )}

        {recentRuns.length > 0 && (
          <section className="records-import-recent">
            <span className="records-eyebrow">Recent imports</span>
            {recentRuns.map((run) => (
              <button type="button" onClick={() => openRun(run.id)} key={run.id}>
                <span>{run.sourceName}</span>
                <small>{run.objectApiName} · {statusLabel(run.status)}</small>
              </button>
            ))}
          </section>
        )}
      </aside>
    </div>
  );
}
