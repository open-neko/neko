"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

type GraphjinConfigSettings = {
  sourceConfigEnabled: boolean;
};

export default function GraphjinConfigControls({
  initial,
}: {
  initial: GraphjinConfigSettings;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.sourceConfigEnabled);
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/graphjin-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceConfigEnabled: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        next
          ? "GraphJin config tools enabled for admins."
          : "GraphJin config tools disabled.",
      );
      router.refresh();
    } catch (e) {
      setEnabled(previous);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <div>
          <h2 className="settings-card-title">Ask-based config</h2>
          <p className="settings-card-copy">
            Admin Ask sessions can inspect GraphJin source mode and file approved
            source, role, and access updates.
          </p>
        </div>
        <span
          className={`text-xs font-bold uppercase tracking-[0.12em] ${
            enabled ? "text-success-ink" : "text-text3"
          }`}
        >
          {saving ? "Saving" : enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-text2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-1 h-4 w-4 cursor-pointer disabled:cursor-not-allowed"
        />
        <span>
          Enable GraphJin config tools for admin Ask sessions and approved MCP
          action execution.
        </span>
      </label>
    </section>
  );
}
