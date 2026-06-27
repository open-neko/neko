import { connection } from "next/server";
import { app_user, asc, db, eq } from "@neko/db";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import { getPluginStatus } from "@/lib/auth";
import { AdminDenied, AdminShell } from "../AdminShell";

export default async function AdminUsersPage() {
  await connection();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") return <AdminDenied />;

  const orgId = await getOrgId();
  const [users, pluginStatus] = await Promise.all([
    db()
      .select({
        id: app_user.id,
        email: app_user.email,
        name: app_user.name,
        role: app_user.role,
        disabledAt: app_user.disabled_at,
        createdAt: app_user.created_at,
        lastLoginAt: app_user.last_login_at,
      })
      .from(app_user)
      .where(eq(app_user.org_id, orgId))
      .orderBy(asc(app_user.email)),
    getPluginStatus(),
  ]);

  return (
    <AdminShell
      title="User administration"
      subtitle={
        pluginStatus.authProvider
          ? `Multi-user mode via ${pluginStatus.authProvider}.`
          : "Solo mode: the userless dashboard is admin by default."
      }
      back={{ href: "/admin", label: "Admin" }}
      wide
    >
      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h2 className="settings-card-title">Users</h2>
            <p className="settings-card-copy">
              App users, roles, account status, and recent sign-in activity.
            </p>
          </div>
          <div className="settings-source">
            <strong className="is-ok">{users.length} total</strong>
          </div>
        </div>

        {users.length === 0 ? (
          <p className="text-sm text-text2">No SSO users have signed in yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="text-[10px] uppercase tracking-[0.12em] text-text3">
                <tr>
                  <th className="border-b border-border px-3 py-2 font-bold">User</th>
                  <th className="border-b border-border px-3 py-2 font-bold">Role</th>
                  <th className="border-b border-border px-3 py-2 font-bold">Status</th>
                  <th className="border-b border-border px-3 py-2 font-bold">Last login</th>
                  <th className="border-b border-border px-3 py-2 font-bold">Created</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-3">
                      <div className="font-semibold text-text">{user.email}</div>
                      <div className="text-xs text-text3">{user.name ?? user.id}</div>
                    </td>
                    <td className="px-3 py-3">
                      <RoleBadge role={user.role} />
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge disabled={Boolean(user.disabledAt)} />
                    </td>
                    <td className="px-3 py-3 text-text2">
                      {formatDate(user.lastLoginAt)}
                    </td>
                    <td className="px-3 py-3 text-text2">
                      {formatDate(user.createdAt)}
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

function RoleBadge({ role }: { role: string }) {
  const isAdmin = role === "admin";
  return (
    <span
      className={`rounded-full px-3 py-1 text-xs font-semibold ${
        isAdmin ? "bg-success-soft text-success-ink" : "bg-neutral text-text2"
      }`}
    >
      {role}
    </span>
  );
}

function StatusBadge({ disabled }: { disabled: boolean }) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-xs font-semibold ${
        disabled ? "bg-danger-soft text-danger" : "bg-success-soft text-success-ink"
      }`}
    >
      {disabled ? "Disabled" : "Active"}
    </span>
  );
}

function formatDate(value: Date | null): string {
  if (!value) return "Never";
  return value.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
