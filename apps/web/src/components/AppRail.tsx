"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Database, LogOut, Table2 } from "lucide-react";
import DensityToggle from "@/components/DensityToggle";
import {
  ALL_NAV,
  hideAppChrome,
  isActive,
  useApprovalsCount,
  type NavDestination,
} from "@/lib/nav";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const VERSION_POLL_MS = 60_000;

type SessionUser = {
  email: string;
  name: string | null;
};

type RecordAppNav = {
  appId: string;
  label: string;
  purpose: string | null;
  objects: Array<{
    apiName: string;
    label: string;
    pluralLabel: string;
    recordCount: string | null;
    custom: boolean;
  }>;
};

function initials(user: SessionUser | null) {
  const source = user?.name || user?.email || "A";
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "A";
}

function RailLink({
  item,
  active,
  pending,
}: {
  item: NavDestination;
  active: boolean;
  pending: number;
}) {
  const Icon = item.icon;
  const isActions = item.href === "/actions";

  return (
    <div className="app-rail-link-wrap">
      <Link
        href={item.href}
        className={`app-rail-link${active ? " is-active" : ""}`}
        aria-current={active ? "page" : undefined}
        title={item.label}
      >
        <Icon aria-hidden="true" strokeWidth={2} />
        <span className="app-rail-label">{item.label}</span>
        <span className="app-rail-short">{item.shortLabel}</span>
        {isActions && pending > 0 && (
          <span className="app-rail-badge font-mono" aria-label={`${pending} pending`}>
            {pending}
          </span>
        )}
      </Link>
    </div>
  );
}

export default function AppRail() {
  const pathname = usePathname() ?? "/";
  const hidden = hideAppChrome(pathname);
  const pending = useApprovalsCount();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionMode, setSessionMode] = useState<
    "loading" | "solo" | "admin" | "member"
  >("loading");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [recordApps, setRecordApps] = useState<RecordAppNav[]>([]);
  const [recordAppsUnavailable, setRecordAppsUnavailable] = useState(false);

  const grouped = useMemo(() => {
    const visible = ALL_NAV.filter(
      (item) =>
        item.href !== "/admin" ||
        (sessionMode !== "loading" && sessionMode !== "member"),
    );
    return {
      primary: visible.filter((n) => n.group === "primary"),
      knowledge: visible.filter((n) => n.group === "knowledge"),
      workspace: visible.filter((n) => n.group === "workspace"),
    };
  }, [sessionMode]);

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as {
          user: { id: string; email: string; name: string | null } | null;
          role: "admin" | "member" | null;
        };
        if (data.user) {
          setUser({ email: data.user.email, name: data.user.name });
          setSessionMode(data.role === "member" ? "member" : "admin");
        } else {
          setSessionMode("solo");
        }
      } catch {
        // Keep admin-only navigation hidden when identity cannot be resolved.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hidden]);

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/a/apps", { cache: "no-store" });
        if (cancelled) return;
        if (!response.ok) {
          setRecordAppsUnavailable(response.status >= 500);
          return;
        }
        const data = (await response.json()) as { apps?: RecordAppNav[] };
        setRecordApps(Array.isArray(data.apps) ? data.apps : []);
        setRecordAppsUnavailable(false);
      } catch {
        if (!cancelled) setRecordAppsUnavailable(true);
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hidden]);

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { version?: string };
        if (!cancelled && typeof data.version === "string") {
          setLatestVersion(data.version);
        }
      } catch {
        // Best effort.
      }
    };
    void check();
    const id = setInterval(check, VERSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hidden]);

  async function handleSignOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/signin";
    }
  }

  if (hidden) return null;

  const updateAvailable =
    latestVersion !== null && latestVersion !== APP_VERSION;

  return (
    <aside className="app-rail-wrap" aria-label="Primary navigation">
      <div className="app-rail-brand">
        <a
          className="app-rail-brand-link"
          href="https://openneko.app"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="OpenNeko — open website in a new tab"
        >
          <Image className="app-rail-logo" src="/cat.png" alt="" width={26} height={27} />
          <span className="app-rail-name">
            OpenNeko
          </span>
        </a>
        {updateAvailable ? (
          <button
            type="button"
            className="app-rail-version is-update"
            onClick={() => window.location.reload()}
            title={`v${latestVersion} available; reload`}
          >
            v{latestVersion}
          </button>
        ) : (
          <span className="app-rail-version">{APP_VERSION}</span>
        )}
      </div>

      <nav className="app-rail-nav">
        <div className="app-rail-group">
          {grouped.primary.map((item) => (
            <RailLink
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
              pending={pending}
            />
          ))}
        </div>

        {(recordApps.length > 0 || recordAppsUnavailable) && (
          <>
            <div className="app-rail-heading app-rail-records-heading">
              {recordAppsUnavailable ? "Apps unavailable" : "Apps"}
            </div>
            {recordApps.map((app) => {
              const appHref = `/a/${app.appId}`;
              const appActive = isActive(pathname, appHref);
              return (
                <div className="app-rail-record-app" key={app.appId}>
                  <div className="app-rail-group">
                    <div className="app-rail-link-wrap">
                      <Link
                        href={appHref}
                        className={`app-rail-link app-rail-record-link${appActive ? " is-active" : ""}`}
                        aria-current={pathname === appHref ? "page" : undefined}
                        title={app.label}
                      >
                        <Database aria-hidden="true" strokeWidth={2} />
                        <span className="app-rail-label">{app.label}</span>
                        <span className="app-rail-short">{app.label.slice(0, 7)}</span>
                      </Link>
                    </div>
                  </div>
                  {appActive && (
                    <div className="app-rail-record-objects" aria-label={`${app.label} objects`}>
                      {app.objects.map((object) => {
                        const href = `${appHref}/${object.apiName}`;
                        const active = isActive(pathname, href);
                        return (
                          <Link
                            key={object.apiName}
                            href={href}
                            className={`app-rail-record-object${active ? " is-active" : ""}`}
                            aria-current={active ? "page" : undefined}
                            title={object.pluralLabel}
                          >
                            <Table2 aria-hidden="true" strokeWidth={1.8} />
                            <span className="app-rail-record-object-label">
                              {object.pluralLabel}
                            </span>
                            {object.custom && (
                              <span className="app-rail-record-custom">__c</span>
                            )}
                            {object.recordCount !== null && (
                              <span className="app-rail-record-count font-mono">
                                {object.recordCount}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        <div className="app-rail-heading">Knowledge</div>
        <div className="app-rail-group">
          {grouped.knowledge.map((item) => (
            <RailLink
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
              pending={pending}
            />
          ))}
        </div>

        <div className="app-rail-heading">Workspace</div>
        <div className="app-rail-group">
          {grouped.workspace.map((item) => (
            <RailLink
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
              pending={pending}
            />
          ))}
        </div>
      </nav>

      <div className="app-rail-foot">
        <div className="app-rail-density">
          <span className="app-rail-foot-label">Density</span>
          <DensityToggle />
        </div>
        {user ? (
          <div className="app-rail-user">
            <Link
              href="/onboarding"
              className="app-rail-user-profile"
              title="Edit personal setup"
            >
              <span className="app-rail-avatar" aria-hidden="true">
                {initials(user)}
              </span>
              <span className="app-rail-user-copy">
                <span className="app-rail-user-name">{user.name || user.email}</span>
                <span className="app-rail-user-email">Personal setup</span>
              </span>
            </Link>
            <button
              type="button"
              className="app-rail-signout"
              onClick={handleSignOut}
              aria-label={`Sign out ${user.email}`}
              title={`Sign out ${user.email}`}
            >
              <LogOut aria-hidden="true" strokeWidth={2} />
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
