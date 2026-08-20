"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";

type SourceSecretSummary = {
  name: string;
  description: string | null;
  updatedAt: string;
};

const INPUT_CLS =
  "px-[13px] py-[11px] sm:px-3.5 sm:py-[13px] rounded-xl border-[1.5px] border-border bg-bg text-text text-base sm:text-ui-body-lg font-body outline-none transition-all duration-200 focus:border-accent focus:shadow-[0_0_0_3px_rgba(107,92,231,0.08)]";
const FIELD_CLS = "flex flex-col gap-2";
const LABEL_CLS = "text-ui-body font-semibold text-text";

export default function SourceSecretsPanel({
  initialSecrets,
}: {
  initialSecrets: SourceSecretSummary[];
}) {
  const [secrets, setSecrets] = useState(initialSecrets);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const res = await fetch("/api/settings/source-secrets");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { secrets?: SourceSecretSummary[] };
    setSecrets(body.secrets ?? []);
  }

  async function saveSecret() {
    setSaving(true);
    try {
      const trimmedName = name.trim();
      const res = await fetch("/api/settings/source-secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          value,
          description: description.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      await refresh();
      setName("");
      setDescription("");
      setValue("");
      toast.success(`Saved ${trimmedName}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSecret(secretName: string) {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/settings/source-secrets?name=${encodeURIComponent(secretName)}`,
        { method: "DELETE" },
      );
      const body = (await res.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setSecrets((prev) => prev.filter((secret) => secret.name !== secretName));
      toast.success(`Removed ${secretName}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <h2 className="settings-card-title">Connection secrets</h2>
          <p className="settings-card-copy">
            Named credentials for GraphJin source registration requests.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_1.2fr_auto]">
        <label className={FIELD_CLS}>
          <span className={LABEL_CLS}>Name</span>
          <input
            className={INPUT_CLS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="WAREHOUSE_DB_PASSWORD"
          />
        </label>
        <label className={FIELD_CLS}>
          <span className={LABEL_CLS}>Description</span>
          <input
            className={INPUT_CLS}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Warehouse read user"
          />
        </label>
        <label className={FIELD_CLS}>
          <span className={LABEL_CLS}>Value</span>
          <input
            className={INPUT_CLS}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Stored encrypted"
          />
        </label>
        <div className="flex items-end">
          <Button
            type="button"
            variant="secondary"
            disabled={saving || !name.trim() || !value}
            onClick={saveSecret}
          >
            Save
          </Button>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-2">
        {secrets.length === 0 ? (
          <p className="text-sm text-text2">No connection secrets stored.</p>
        ) : (
          secrets.map((secret) => (
            <div
              key={secret.name}
              className="flex items-center gap-3 rounded-lg border border-border bg-bg px-3 py-2 text-sm"
            >
              <code className="min-w-0 flex-1 truncate text-text">
                {secret.name}
              </code>
              <span className="hidden min-w-0 flex-1 truncate text-text3 md:block">
                {secret.description ?? "No description"}
              </span>
              <span className="text-xs text-text3">
                {formatDate(secret.updatedAt)}
              </span>
              <button
                type="button"
                className="border-0 bg-transparent p-0 text-xs font-semibold text-danger underline disabled:cursor-not-allowed disabled:opacity-50"
                disabled={saving}
                onClick={() => void deleteSecret(secret.name)}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}
