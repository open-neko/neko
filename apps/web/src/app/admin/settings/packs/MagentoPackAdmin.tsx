"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import AppHeader from "@/components/AppHeader";
import PageHeading from "@/components/PageHeading";
import SectionNav from "@/components/SectionNav";
import { Button } from "@/components/ui/Button";

type PackStatus = {
  packId: string;
  version: string;
  status: string;
  readiness: Record<string, { status: string; reason: string | null }>;
  installedAt: string | null;
  lastError: string | null;
};

type DoctorResult = {
  packId: string;
  status: string;
  checks: Array<{ id: string; status: string; detail: string }>;
};

type StoreControl = {
  domain: string;
  automationEligible: boolean;
  enabled: boolean;
  autoExecute: boolean;
  readiness: string;
  readinessReason: string | null;
  caps: Record<string, number>;
};

type StoreManagement = {
  controls: StoreControl[];
  rules: Array<{
    id: string;
    name: string;
    instruction: string;
    domain: string;
    actionKind: string;
    dailyCap: number;
    cooldownSeconds: number;
    enabled: boolean;
    suspendedReason: string | null;
  }>;
  changesets: Array<{
    id: string;
    domain: string;
    operationId: string;
    executionMode: string;
    status: string;
    summary: string;
    bulkUuid: string | null;
    inverseOfId: string | null;
    createdAt: string;
  }>;
  handoffs: Array<{
    id: string;
    kind: string;
    entityRef: string;
    status: string;
    createdAt: string;
  }>;
  handoffOnly: { executePath: false; handoffKinds: string[] };
};

type FormState = {
  baseUrl: string;
  databaseHost: string;
  databasePort: string;
  databaseName: string;
  analyticsUsername: string;
  analyticsPassword: string;
  storeCode: string;
  tablePrefix: string;
  integrationToken: string;
};

const initialForm: FormState = {
  baseUrl: "http://host.docker.internal:8080",
  databaseHost: "host.docker.internal",
  databasePort: "3306",
  databaseName: "magento",
  analyticsUsername: "magento_analytics",
  analyticsPassword: "",
  storeCode: "all",
  tablePrefix: "",
  integrationToken: "",
};

const FIELD = "flex flex-col gap-2";
const LABEL = "text-ui-body font-semibold text-text";
const HELP = "text-ui-body-sm leading-[1.45] text-text3";
const INPUT = "rounded-xl border-[1.5px] border-border bg-bg px-3.5 py-3 text-ui-body-lg text-text outline-none transition focus:border-accent focus:shadow-[0_0_0_3px_rgba(107,92,231,0.08)]";
const REPORTING_LOGIN_REQUEST = `Please create a dedicated read-only MariaDB/MySQL login for OpenNeko analytics on our Magento database.

Grant only SELECT and SHOW VIEW on the Magento database. Do not grant INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, ALL PRIVILEGES, or GRANT OPTION.

Please send me the database hostname, port, database name, username, and password, and allow connections from the server running OpenNeko.`;

const CAP_LABELS: Record<string, string> = {
  maxRowsPerChangeset: "Rows per change-set",
  maxPriceDeltaPercent: "Price delta (%)",
  maxDiscountPercent: "Discount (%)",
  maxCouponCount: "Coupons",
  maxProjectedExposure: "Projected exposure",
  maxDailyAutoActions: "Automatic actions/day",
  skuCooldownSeconds: "Entity cooldown (seconds)",
};

function visibleCaps(control: StoreControl): Array<[string, number]> {
  const keys = ["maxRowsPerChangeset", "maxDailyAutoActions", "skuCooldownSeconds"];
  if (control.domain === "catalog") keys.push("maxPriceDeltaPercent");
  if (control.domain === "promotions") {
    keys.push("maxDiscountPercent", "maxCouponCount", "maxProjectedExposure");
  }
  return keys.flatMap((key) =>
    typeof control.caps[key] === "number" ? [[key, control.caps[key]] as [string, number]] : [],
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (HTTP ${response.status})`);
  return body as T;
}

function healthLabel(status: string): string {
  if (status === "ready" || status === "installed") return "Healthy";
  if (status === "degraded") return "Needs attention";
  if (status === "removed") return "Not installed";
  return status.replaceAll("_", " ");
}

function checkLabel(id: string): string {
  if (id === "operator") return "Magento access";
  if (id === "analytics-query") return "Reporting query";
  return id.replaceAll("-", " ");
}

function checkStatusLabel(id: string, status: string): string {
  if (id === "operator") return status === "ready" ? "Changes available" : "View only";
  if (status === "ready") return "Healthy";
  if (status === "optional") return "Optional";
  if (status === "blocked") return "Needs attention";
  return status.replaceAll("_", " ");
}

function checkTone(status: string): string {
  if (status === "ready") return "text-success-ink";
  if (status === "optional") return "text-text3";
  return "text-danger";
}

function executionModeLabel(mode: string): string {
  if (mode === "approval_required") return "Administrator approval required";
  if (mode === "controlled_automation_eligible") return "Can run automatically within limits";
  if (mode === "handoff_only") return "Complete in Magento Admin";
  return mode.replaceAll("_", " ");
}

export default function MagentoPackAdmin() {
  const [status, setStatus] = useState<PackStatus | null>(null);
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);
  const [management, setManagement] = useState<StoreManagement | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [rotateCredentials, setRotateCredentials] = useState(false);
  const [clearIntegrationToken, setClearIntegrationToken] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);
  const [rule, setRule] = useState({
    name: "",
    instruction: "",
    domain: "catalog",
    dailyCap: "5",
    cooldownSeconds: "3600",
  });

  const refresh = useCallback(async (runDoctor = false) => {
    setLoading(true);
    try {
      const nextStatus = await api<PackStatus>("/api/admin/packs/magento/status").catch((error) => {
        if (error instanceof Error && error.message.includes("not installed")) return null;
        throw error;
      });
      setStatus(nextStatus);
      if (nextStatus && nextStatus.status !== "removed") {
        const [nextManagement, nextDoctor] = await Promise.all([
          api<StoreManagement>("/api/admin/packs/magento/store-management"),
          runDoctor ? api<DoctorResult>("/api/admin/packs/magento/doctor") : Promise.resolve(null),
        ]);
        setManagement(nextManagement);
        if (nextDoctor) setDoctor(nextDoctor);
      } else if (!nextStatus || nextStatus.status === "removed") {
        setDoctor(null);
        setManagement(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(initial);
  }, [refresh]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("install");
    try {
      await api<PackStatus>("/api/admin/packs/magento/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: {
            "magento.base_url": form.baseUrl,
            "magento.store_code": form.storeCode || "all",
            "magento.table_prefix": form.tablePrefix,
            "database.connectivity_mode": form.databaseHost === "host.docker.internal" ? "host_gateway" : "remote",
            "database.host": form.databaseHost,
            "database.port": Number(form.databasePort),
            "database.name": form.databaseName,
          },
          secrets: {
            "database.analytics_username": form.analyticsUsername,
            "database.analytics_password": form.analyticsPassword,
            ...(form.integrationToken ? { "magento.integration_token": form.integrationToken } : {}),
          },
        }),
      });
      setForm((current) => ({ ...current, analyticsPassword: "", integrationToken: "" }));
      toast.success("Magento is connected. Metrics are refreshing now.");
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function copyReportingLoginRequest() {
    try {
      await navigator.clipboard.writeText(REPORTING_LOGIN_REQUEST);
      toast.success("Request copied. Send it to your Magento host or database administrator.");
    } catch {
      toast.error("Could not copy automatically. Select and copy the request manually.");
    }
  }

  async function runAction(action: "doctor" | "upgrade" | "uninstall") {
    if (action === "uninstall" && !window.confirm("Remove the Magento pack? Historical metrics and operation records will be kept.")) return;
    setBusy(action);
    try {
      if (action === "doctor") {
        setDoctor(await api<DoctorResult>("/api/admin/packs/magento/doctor"));
        toast.success("Connection and permissions checked.");
      } else {
        await api<PackStatus>(`/api/admin/packs/magento/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        toast.success(action === "upgrade" ? "Magento pack updated." : "Magento pack removed safely.");
        await refresh(action === "upgrade");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form.analyticsPassword && !form.analyticsUsername) {
      toast.error("Enter the reporting username that belongs to this password.");
      return;
    }
    if (!form.analyticsPassword && !form.integrationToken && !clearIntegrationToken) {
      toast.error("Enter a new reporting password, an API token, or choose to remove the API token.");
      return;
    }
    setBusy("configure");
    try {
      const secrets = {
        ...(form.analyticsPassword
          ? {
              "database.analytics_username": form.analyticsUsername,
              "database.analytics_password": form.analyticsPassword,
            }
          : {}),
        ...(form.integrationToken
          ? { "magento.integration_token": form.integrationToken }
          : clearIntegrationToken
            ? { "magento.integration_token": "" }
            : {}),
      };
      await api<PackStatus>("/api/admin/packs/magento/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets }),
      });
      setForm((current) => ({ ...current, analyticsPassword: "", integrationToken: "" }));
      setRotateCredentials(false);
      setClearIntegrationToken(false);
      toast.success("Credentials updated and verified.");
      await refresh(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function updateStoreManagement(
    key: string,
    input: Record<string, unknown>,
    success: string,
  ) {
    setBusy(key);
    try {
      const next = await api<StoreManagement>("/api/admin/packs/magento/store-management", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setManagement(next);
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const eligibleDomains = management?.controls.filter(
      (control) => control.enabled && control.autoExecute && control.automationEligible,
    ) ?? [];
    const domain = eligibleDomains.some((control) => control.domain === rule.domain)
      ? rule.domain
      : eligibleDomains[0]?.domain;
    if (!domain) {
      toast.error("Turn on automatic actions for an eligible domain first.");
      return;
    }
    await updateStoreManagement(
      "create-rule",
      {
        action: "create_rule",
        name: rule.name,
        instruction: rule.instruction,
        domain,
        actionKind: `magento.manage_${domain}`,
        dailyCap: Number(rule.dailyCap),
        cooldownSeconds: Number(rule.cooldownSeconds),
        enabled: true,
      },
      "Automatic rule saved with its own cap and cooldown.",
    );
    setRule((current) => ({ ...current, name: "", instruction: "" }));
  }

  const installed = status && status.status !== "removed";

  return (
    <div className="root" style={{ "--page-width": "min(1000px, 100%)" } as React.CSSProperties}>
      <AppHeader back={{ href: "/admin/settings", label: "All settings" }}>
        <SectionNav current="admin" />
      </AppHeader>
      <PageHeading
        eyebrow="Settings · Packs"
        title="Magento"
        description="Connect the store once, then keep its health, metrics, automations, and credentials in one place."
      />

      {loading && !status ? (
        <section className="settings-card"><p className="settings-card-copy">Checking Magento…</p></section>
      ) : installed ? (
        <div className="flex flex-col gap-4">
          <section className="settings-card">
            <div className="settings-card-head">
              <div>
                <h2 className="settings-card-title">Magento pack</h2>
                <p className="settings-card-copy">Version {status.version} · installed {status.installedAt ? new Date(status.installedAt).toLocaleString() : "recently"}</p>
              </div>
              <div className="settings-source">
                <strong className={doctor?.status === "blocked" ? "is-warn" : "is-ok"}>{healthLabel(doctor?.status ?? status.status)}</strong>
              </div>
            </div>
            {status.lastError ? <p className="mt-3 text-sm text-danger">{status.lastError}</p> : null}
            <div className="mt-5 flex flex-wrap gap-2">
              <Button type="button" disabled={busy !== null} onClick={() => void runAction("doctor")}>{busy === "doctor" ? "Checking…" : "Check health"}</Button>
              <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void runAction("upgrade")}>{busy === "upgrade" ? "Updating…" : "Update pack"}</Button>
              <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => setRotateCredentials((value) => !value)}>Change credentials</Button>
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-head">
              <div>
                <h2 className="settings-card-title">Use your Magento pack</h2>
                <p className="settings-card-copy">Everything is installed already. These are the everyday places your team will use.</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {[
                { href: "/", title: "View Magento metrics", copy: "See current store performance and findings." },
                { href: "/workflows", title: "Run automations", copy: "Start or review Magento workflows." },
                { href: "/actions", title: "Review proposed changes", copy: "Approve or reject a specific Magento change prepared by OpenNeko." },
                { href: "/skills", title: "Magento operator skills", copy: "Choose a focused skill for orders, fulfillment, refunds, inventory, performance, or platform health." },
              ].map((item) => (
                <Link key={item.href} href={item.href} className="rounded-xl border border-border px-4 py-3 transition hover:border-accent">
                  <strong className="text-sm text-text">{item.title}</strong>
                  <p className="mt-1 text-ui-body-sm leading-[1.45] text-text3">{item.copy}</p>
                </Link>
              ))}
            </div>
          </section>

          {management ? (
            <section className="settings-card">
              <div className="settings-card-head">
                <div>
                  <h2 className="settings-card-title">Store change access</h2>
                  <p className="settings-card-copy">Choose which areas can prepare changes. Sensitive changes always require administrator approval, and every write is reconciled against Magento.</p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {management.controls.map((control) => (
                  <div key={control.domain} className="rounded-xl border border-border px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <strong className="text-sm capitalize text-text">{control.domain}</strong>
                        <p className="mt-1 text-ui-body-sm text-text3">
                          {control.automationEligible
                            ? "Eligible actions can run automatically within limits; sensitive changes still require approval."
                            : "Every change requires administrator approval."}
                        </p>
                        <p className={`mt-2 text-xs font-semibold ${control.readiness === "ready" && control.enabled ? "text-success-ink" : "text-text3"}`}>
                          {control.readiness !== "ready" || !control.enabled
                            ? "View only"
                            : control.autoExecute
                              ? "Auto within rules"
                              : "Approved changes"}
                          {control.readinessReason && control.readiness !== "ready"
                            ? ` · ${control.readinessReason.replaceAll("_", " ")}`
                            : ""}
                        </p>
                      </div>
                      <label className="flex items-center gap-2 text-xs font-semibold text-text2">
                        <input
                          type="checkbox"
                          checked={control.enabled}
                          disabled={busy !== null}
                          onChange={(event) => void updateStoreManagement(
                            `domain-${control.domain}`,
                            { action: "update_domain", domain: control.domain, enabled: event.target.checked },
                            `${control.domain} change access updated.`,
                          )}
                        />
                        Enabled
                      </label>
                    </div>
                    <label className="mt-4 flex items-center gap-2 text-ui-body-sm text-text2">
                      <input
                        type="checkbox"
                        checked={control.autoExecute}
                        disabled={busy !== null || !control.enabled || !control.automationEligible}
                        onChange={(event) => void updateStoreManagement(
                          `auto-${control.domain}`,
                          { action: "update_domain", domain: control.domain, autoExecute: event.target.checked },
                          `${control.domain} automatic execution updated.`,
                        )}
                      />
                      Allow automatic actions within limits
                    </label>
                    <p className="mt-2 text-xs leading-[1.45] text-text3">Up to {control.caps.maxRowsPerChangeset ?? 0} rows per change-set; {control.caps.maxDailyAutoActions ?? 0} automatic actions per day.</p>
                    <details className="mt-3 border-t border-border pt-3">
                      <summary className="cursor-pointer text-xs font-semibold text-text2">Edit caps</summary>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {visibleCaps(control).map(([key, value]) => (
                          <label key={`${control.domain}-${key}`} className="flex flex-col gap-1 text-xs text-text3">
                            {CAP_LABELS[key] ?? key}
                            <input
                              key={`${control.domain}-${key}-${value}`}
                              type="number"
                              min="0"
                              defaultValue={value}
                              disabled={busy !== null}
                              className="rounded-lg border border-border bg-bg px-2.5 py-2 text-sm text-text outline-none focus:border-accent"
                              onBlur={(event) => {
                                const next = Number(event.target.value);
                                if (Number.isFinite(next) && next >= 0 && next !== value) {
                                  void updateStoreManagement(
                                    `cap-${control.domain}-${key}`,
                                    { action: "update_domain", domain: control.domain, caps: { [key]: next } },
                                    `${control.domain} cap updated.`,
                                  );
                                }
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </details>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
                <strong className="text-sm text-text">Actions OpenNeko will not perform</strong>
                <p className="mt-1 text-ui-body-sm leading-[1.5] text-text2">OpenNeko cannot issue online refunds, approve returns, change financial configuration, or perform money-out operations. It prepares evidence and a Magento Admin handoff only.</p>
              </div>

              <div className="mt-6 border-t border-border pt-5">
                <h3 className="text-sm font-semibold text-text">Automatic rules</h3>
                <p className="mt-1 text-ui-body-sm text-text3">Rules run only where automatic actions are enabled and stop at their daily limit or per-entity cooldown.</p>
                {management.controls.some((control) => control.enabled && control.autoExecute && control.automationEligible) ? (
                  <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={createRule}>
                    <label className={FIELD}>
                      <span className={LABEL}>Rule name</span>
                      <input required maxLength={120} className={INPUT} value={rule.name} onChange={(event) => setRule((current) => ({ ...current, name: event.target.value }))} />
                    </label>
                    <label className={FIELD}>
                      <span className={LABEL}>Domain</span>
                      <select className={INPUT} value={rule.domain} onChange={(event) => setRule((current) => ({ ...current, domain: event.target.value }))}>
                        {management.controls.filter((control) => control.enabled && control.autoExecute && control.automationEligible).map((control) => <option key={control.domain} value={control.domain}>{control.domain}</option>)}
                      </select>
                    </label>
                    <label className={`${FIELD} sm:col-span-2`}>
                      <span className={LABEL}>Plain-language instruction</span>
                      <textarea required maxLength={1000} rows={3} className={INPUT} value={rule.instruction} onChange={(event) => setRule((current) => ({ ...current, instruction: event.target.value }))} />
                    </label>
                    <label className={FIELD}>
                      <span className={LABEL}>Daily cap</span>
                      <input required type="number" min="1" className={INPUT} value={rule.dailyCap} onChange={(event) => setRule((current) => ({ ...current, dailyCap: event.target.value }))} />
                    </label>
                    <label className={FIELD}>
                      <span className={LABEL}>Entity cooldown (seconds)</span>
                      <input required type="number" min="0" className={INPUT} value={rule.cooldownSeconds} onChange={(event) => setRule((current) => ({ ...current, cooldownSeconds: event.target.value }))} />
                    </label>
                    <div className="sm:col-span-2"><Button type="submit" disabled={busy !== null}>{busy === "create-rule" ? "Saving…" : "Save automatic rule"}</Button></div>
                  </form>
                ) : (
                  <p className="mt-3 rounded-lg bg-bg2 px-3 py-3 text-ui-body-sm text-text3">Turn on “Allow automatic actions within limits” for an eligible area before creating a rule.</p>
                )}
                {management.rules.length > 0 ? (
                  <ul className="mt-4 flex flex-col gap-2">
                    {management.rules.map((item) => (
                      <li key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-border px-4 py-3">
                        <div>
                          <strong className="text-sm text-text">{item.name}</strong>
                          <p className="mt-1 text-ui-body-sm text-text3">{item.instruction}</p>
                          <p className="mt-1 text-xs capitalize text-text3">{item.domain} · {item.dailyCap}/day · {item.cooldownSeconds}s cooldown{item.suspendedReason ? ` · ${item.suspendedReason.replaceAll("_", " ")}` : ""}</p>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy !== null}
                          onClick={() => void updateStoreManagement(
                            `rule-${item.id}`,
                            { action: "set_rule_status", ruleId: item.id, enabled: !item.enabled },
                            item.enabled ? "Automatic rule suspended." : "Automatic rule enabled.",
                          )}
                        >{item.enabled ? "Suspend" : "Enable"}</Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="mt-6 border-t border-border pt-5">
                <h3 className="text-sm font-semibold text-text">Recent change-sets and handoffs</h3>
                {management.changesets.length === 0 && management.handoffs.length === 0 ? (
                  <p className="mt-2 text-ui-body-sm text-text3">No Magento changes have been exercised yet.</p>
                ) : (
                  <ul className="mt-3 flex flex-col gap-2">
                    {management.changesets.slice(0, 8).map((changeset) => (
                      <li key={changeset.id} className="rounded-xl border border-border px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <strong className="text-sm text-text">{changeset.summary}</strong>
                            <p className="mt-1 text-xs capitalize text-text3">{changeset.domain} · {changeset.operationId.replaceAll("_", " ")} · {executionModeLabel(changeset.executionMode)}{changeset.inverseOfId ? " · inverse" : ""}</p>
                          </div>
                          <span className="text-xs font-semibold uppercase tracking-wide text-text2">{changeset.status.replaceAll("_", " ")}</span>
                        </div>
                      </li>
                    ))}
                    {management.handoffs.slice(0, 4).map((handoff) => (
                      <li key={handoff.id} className="rounded-xl border border-border px-4 py-3">
                        <strong className="text-sm text-text">Magento Admin handoff · {handoff.kind.replaceAll("_", " ")}</strong>
                        <p className="mt-1 text-xs text-text3">{handoff.entityRef} · {handoff.status.replaceAll("_", " ")}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ) : null}

          {doctor ? (
            <section className="settings-card">
              <div className="settings-card-head">
                <div>
                  <h2 className="settings-card-title">Health</h2>
                  <p className="settings-card-copy">Plain-language checks for Magento, the reporting connection, and OpenNeko.</p>
                </div>
              </div>
              <ul className="mt-4 flex flex-col gap-3">
                {doctor.checks.map((check) => (
                  <li key={check.id} className="flex flex-col gap-1 rounded-xl border border-border px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <strong className="text-sm capitalize text-text">{checkLabel(check.id)}</strong>
                      <p className="mt-1 text-ui-body-sm leading-[1.45] text-text3">{check.detail}</p>
                    </div>
                    <span className={`mt-1 text-xs font-semibold uppercase tracking-wide ${checkTone(check.status)}`}>{checkStatusLabel(check.id, check.status)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {rotateCredentials ? (
            <form className="settings-card" onSubmit={saveCredentials}>
              <div className="settings-card-head">
                <div>
                  <h2 className="settings-card-title">Change credentials</h2>
                  <p className="settings-card-copy">Only enter credentials you want to change. New values are tested before replacing the saved ones.</p>
                </div>
              </div>
              <CredentialFields form={form} update={update} includeToken required={false} />
              <label className="mt-4 flex items-center gap-2 text-sm text-text2">
                <input
                  type="checkbox"
                  checked={clearIntegrationToken}
                  disabled={Boolean(form.integrationToken)}
                  onChange={(event) => setClearIntegrationToken(event.target.checked)}
                />
                Remove the saved Magento API token
              </label>
              <div className="mt-5 flex gap-2">
                <Button type="submit" disabled={busy !== null}>{busy === "configure" ? "Testing and saving…" : "Save credentials"}</Button>
                <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => setRotateCredentials(false)}>Cancel</Button>
              </div>
            </form>
          ) : null}

          <section className="settings-card">
            <div className="settings-card-head">
              <div>
                <h2 className="settings-card-title">Remove pack</h2>
                <p className="settings-card-copy">Disables its live configuration and automations. Historical metrics and audit records stay available.</p>
              </div>
              <Button type="button" variant="danger" disabled={busy !== null} onClick={() => void runAction("uninstall")}>{busy === "uninstall" ? "Removing…" : "Remove"}</Button>
            </div>
          </section>
        </div>
      ) : (
        <form className="settings-card" onSubmit={install}>
          <div className="settings-card-head">
            <div>
              <h2 className="settings-card-title">Connect Magento</h2>
              <p className="settings-card-copy">Use a read-only reporting login. OpenNeko discovers the store settings and installs the complete pack automatically.</p>
            </div>
            <div className="settings-source"><strong>About 2 minutes</strong></div>
          </div>

          <details className="mt-5 rounded-xl border border-border bg-bg2 px-4 py-3 text-sm text-text2">
            <summary className="cursor-pointer font-semibold text-text">I do not have a read-only reporting login</summary>
            <p className="mt-3 leading-[1.5]">Send this request to your Magento hosting provider or database administrator. OpenNeko never needs your Magento administrator password or Adobe Marketplace keys.</p>
            <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-bg px-3 py-3 text-xs leading-[1.5] text-text2">{REPORTING_LOGIN_REQUEST}</pre>
            <Button type="button" variant="secondary" className="mt-3" onClick={() => void copyReportingLoginRequest()}>Copy request</Button>
          </details>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className={`${FIELD} sm:col-span-2`}>
              <span className={LABEL}>Magento address</span>
              <input required type="url" className={INPUT} value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} />
              <span className={HELP}>The storefront URL as seen from OpenNeko. The default works when Magento is another local Docker or OrbStack stack.</span>
            </label>
            <label className={FIELD}>
              <span className={LABEL}>Database address</span>
              <input required className={INPUT} value={form.databaseHost} onChange={(event) => update("databaseHost", event.target.value)} />
            </label>
            <label className={FIELD}>
              <span className={LABEL}>Database name</span>
              <input required className={INPUT} value={form.databaseName} onChange={(event) => update("databaseName", event.target.value)} />
            </label>
          </div>

          <CredentialFields form={form} update={update} required />

          <button type="button" className="mt-5 text-sm font-semibold text-text2 underline" onClick={() => setAdvanced((value) => !value)}>{advanced ? "Hide advanced settings" : "Advanced settings"}</button>
          {advanced ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className={FIELD}>
                <span className={LABEL}>Database port</span>
                <input required type="number" min="1" max="65535" className={INPUT} value={form.databasePort} onChange={(event) => update("databasePort", event.target.value)} />
              </label>
              <label className={FIELD}>
                <span className={LABEL}>Store code</span>
                <input className={INPUT} value={form.storeCode} onChange={(event) => update("storeCode", event.target.value)} />
              </label>
              <label className={FIELD}>
                <span className={LABEL}>Table prefix</span>
                <input className={INPUT} value={form.tablePrefix} onChange={(event) => update("tablePrefix", event.target.value)} />
              </label>
              <label className={FIELD}>
                <span className={LABEL}>Magento API token (optional)</span>
                <input type="password" autoComplete="off" className={INPUT} value={form.integrationToken} onChange={(event) => update("integrationToken", event.target.value)} />
                <span className={HELP}>This token is only for specific Magento changes that OpenNeko supports. Each change must be enabled by an administrator and still requires approval.</span>
              </label>
            </div>
          ) : null}

          <div className="mt-6 rounded-xl border border-border bg-bg2 px-4 py-3 text-ui-body-sm leading-[1.5] text-text2">
            OpenNeko starts in view-only mode: it can analyze the store but cannot change Magento data. Any supported change is enabled separately by an administrator and requires approval.
          </div>
          <div className="mt-5">
            <Button type="submit" disabled={busy !== null || !form.analyticsPassword}>{busy === "install" ? "Connecting and installing…" : "Connect and install"}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function CredentialFields({
  form,
  update,
  includeToken = false,
  required,
}: {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  includeToken?: boolean;
  required: boolean;
}) {
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className={FIELD}>
        <span className={LABEL}>Read-only reporting username</span>
        <input required={required} autoComplete="username" className={INPUT} value={form.analyticsUsername} onChange={(event) => update("analyticsUsername", event.target.value)} />
      </label>
      <label className={FIELD}>
        <span className={LABEL}>Read-only reporting password</span>
        <input required={required} type="password" autoComplete="new-password" className={INPUT} value={form.analyticsPassword} onChange={(event) => update("analyticsPassword", event.target.value)} />
        {!required ? <span className={HELP}>Leave blank to keep the saved reporting login.</span> : null}
      </label>
      {includeToken ? (
        <label className={`${FIELD} sm:col-span-2`}>
          <span className={LABEL}>Magento API token (optional)</span>
          <input type="password" autoComplete="off" className={INPUT} value={form.integrationToken} onChange={(event) => update("integrationToken", event.target.value)} />
          <span className={HELP}>Leave blank to keep the saved token. A token alone does not allow OpenNeko to change Magento.</span>
        </label>
      ) : null}
    </div>
  );
}
