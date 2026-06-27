import { connection } from "next/server";
import { getCurrentActor } from "@/lib/actor";
import { getPluginActionDescriptors, getPluginStatus } from "@/lib/auth";
import { AdminDenied, AdminShell } from "../AdminShell";

export default async function AdminPluginsPage() {
  await connection();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") return <AdminDenied />;

  const [status, descriptors] = await Promise.all([
    getPluginStatus(),
    getPluginActionDescriptors(),
  ]);

  return (
    <AdminShell
      title="Plugin administration"
      subtitle="Registry health, capabilities, action descriptors, and provider surfaces."
      back={{ href: "/admin", label: "Admin" }}
      wide
    >
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Loaded" value={status.loaded.length} />
        <Stat
          label="Flagged"
          value={status.flagged.length}
          warn={status.flagged.length > 0}
        />
        <Stat label="Action kinds" value={status.kinds.length} />
        <Stat label="VMs" value={status.vmsRunning} />
      </div>

      <div className="grid gap-4 mt-6 lg:grid-cols-2">
        <section className="settings-card">
          <div className="settings-card-head">
            <div>
              <h2 className="settings-card-title">Registry</h2>
              <p className="settings-card-copy">
                Loaded, skipped, and flagged plugin packages.
              </p>
            </div>
            <div className="settings-source">
              <strong className={status.flagged.length > 0 ? "is-warn" : "is-ok"}>
                {status.flagged.length > 0 ? "Needs review" : "Clean"}
              </strong>
            </div>
          </div>
          <ListBlock label="Loaded" values={status.loaded} />
          <ListBlock
            label="Skipped"
            values={status.skipped.map((item) => `${item.name}: ${item.reason}`)}
          />
          <ListBlock
            label="Flagged"
            values={status.flagged.map(
              (item) => `${item.pluginName}: ${item.reason}`,
            )}
            warn
          />
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <div>
              <h2 className="settings-card-title">Providers</h2>
              <p className="settings-card-copy">
                Auth and channel capabilities declared by installed plugins.
              </p>
            </div>
          </div>
          <ListBlock
            label="Auth provider"
            values={status.authProvider ? [status.authProvider] : []}
          />
          <ListBlock
            label="Channels"
            values={status.channels.map(
              (channel) => `${channel.providerLabel} (${channel.pluginId})`,
            )}
          />
        </section>
      </div>

      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h2 className="settings-card-title">Action descriptors</h2>
            <p className="settings-card-copy">
              Registered plugin action kinds and their default approval modes.
            </p>
          </div>
        </div>
        {descriptors.length === 0 ? (
          <p className="text-sm text-text2">No plugin actions registered.</p>
        ) : (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="text-[10px] uppercase tracking-[0.12em] text-text3">
                <tr>
                  <th className="border-b border-border px-3 py-2 font-bold">Kind</th>
                  <th className="border-b border-border px-3 py-2 font-bold">Mode</th>
                  <th className="border-b border-border px-3 py-2 font-bold">Description</th>
                </tr>
              </thead>
              <tbody>
                {descriptors.map((descriptor) => (
                  <tr key={descriptor.kind} className="border-b border-border last:border-0">
                    <td className="px-3 py-3 font-mono text-xs text-text">
                      {descriptor.kind}
                    </td>
                    <td className="px-3 py-3 text-xs text-text2">
                      {formatMode(descriptor.default_mode)}
                    </td>
                    <td className="px-3 py-3 text-text2">
                      {descriptor.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AdminShell>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-[14px] border border-border bg-card px-4 py-3 shadow-soft">
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-text3">
        {label}
      </div>
      <div
        className={`mt-2 font-display text-2xl font-bold ${
          warn ? "text-danger" : "text-text"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function ListBlock({
  label,
  values,
  warn = false,
}: {
  label: string;
  values: string[];
  warn?: boolean;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-text3">
        {label}
      </div>
      {values.length === 0 ? (
        <div className="border-l border-border pl-3 py-1 text-sm text-text3">
          None
        </div>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {values.map((value) => (
            <li
              key={value}
              className={`border-l pl-3 text-sm leading-6 ${
                warn ? "border-danger text-danger" : "border-border text-text2"
              }`}
            >
              {value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatMode(
  mode:
    | "auto"
    | "ask"
    | "deny"
    | { external?: "auto" | "ask" | "deny"; internal?: "auto" | "ask" | "deny" }
    | undefined,
): string {
  if (!mode) return "default";
  if (typeof mode === "string") return mode;
  return `external:${mode.external ?? "default"} - internal:${mode.internal ?? "default"}`;
}
