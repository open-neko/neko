"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  hasSignedIn: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
}

/**
 * Interactive user administration: provision users ahead of first
 * sign-in (required for manual-provisioning auth like magic link),
 * change roles, and disable/enable accounts. The API enforces the
 * last-active-admin guard; errors from it surface inline.
 */
export function UsersClient({ users }: { users: AdminUserRow[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function callApi(path: string, init: RequestInit): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? `request failed (${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create");
    const ok = await callApi("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email,
        name: name.trim().length > 0 ? name : undefined,
        role,
      }),
    });
    if (ok) {
      setEmail("");
      setName("");
      setRole("member");
    }
    setBusy(null);
  }

  async function patchUser(
    id: string,
    patch: { role?: string; disabled?: boolean },
  ) {
    setBusy(id);
    await callApi(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    setBusy(null);
  }

  return (
    <>
      {error ? (
        <div className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : null}

      <form
        onSubmit={createUser}
        className="mb-6 flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-xs font-semibold text-text2">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@company.com"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm font-normal text-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-text2">
          Name (optional)
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Display name"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm font-normal text-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-text2">
          Role
          <select
            value={role}
            onChange={(event) =>
              setRole(event.target.value === "admin" ? "admin" : "member")
            }
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm font-normal text-text"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy === "create"}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-ink disabled:opacity-50"
        >
          {busy === "create" ? "Adding…" : "Add user"}
        </button>
      </form>

      {users.length === 0 ? (
        <p className="text-sm text-text2">
          No users yet. Add one above to allow them to sign in.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="text-ui-label uppercase tracking-[0.12em] text-text3">
              <tr>
                <th className="border-b border-border px-3 py-2 font-bold">User</th>
                <th className="border-b border-border px-3 py-2 font-bold">Role</th>
                <th className="border-b border-border px-3 py-2 font-bold">Status</th>
                <th className="border-b border-border px-3 py-2 font-bold">Last login</th>
                <th className="border-b border-border px-3 py-2 font-bold">Created</th>
                <th className="border-b border-border px-3 py-2 font-bold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-3">
                    <div className="font-semibold text-text">{user.email}</div>
                    <div className="text-xs text-text3">
                      {user.name ?? user.id}
                      {user.hasSignedIn ? null : " · never signed in"}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge disabled={user.disabled} />
                  </td>
                  <td className="px-3 py-3 text-text2">
                    {formatDate(user.lastLoginAt)}
                  </td>
                  <td className="px-3 py-3 text-text2">
                    {formatDate(user.createdAt)}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy === user.id}
                        onClick={() =>
                          patchUser(user.id, {
                            role: user.role === "admin" ? "member" : "admin",
                          })
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs font-semibold text-text2 hover:text-text disabled:opacity-50"
                      >
                        {user.role === "admin" ? "Make member" : "Make admin"}
                      </button>
                      <button
                        type="button"
                        disabled={busy === user.id}
                        onClick={() =>
                          patchUser(user.id, { disabled: !user.disabled })
                        }
                        className="rounded-md border border-border px-2 py-1 text-xs font-semibold text-text2 hover:text-text disabled:opacity-50"
                      >
                        {user.disabled ? "Enable" : "Disable"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
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

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
