/**
 * POST /api/admin/change-password
 *
 * Bootstraps the admin's chosen DB password on first run. Steps:
 *   1. Transactionally rotate the `neko` metadata role and dedicated records
 *      role while both old connections are live.
 *   2. Persist both passwords to `~/.config/openneko/config.json` so every
 *      process and generated GraphJin config picks them up.
 *   3. Drain both web pools so subsequent queries use the new password.
 *   4. Fire-and-forget POST /admin/reconnect to the worker so its
 *      pg-boss singleton (which holds the OLD credentials in its own
 *      pool, separate from the web's @neko/db pool) restarts with fresh
 *      creds. WORKER_ADMIN_URL is set by Docker Compose; local dev falls
 *      back to localhost. Tolerates the worker being down — the password
 *      still rotates successfully on the web side.
 *
 * The body must contain a non-empty password. The default `"secret"` is
 * rejected — we want a real change. Length minimum is intentionally
 * loose (8 chars) since this is a host-local DB password, not a public
 * credential; the operator picks the policy.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  buildRecordsPoolConfig,
  hasCustomPassword,
  pool,
  reconnectPool,
  writeLocalConfig,
} from "@neko/db";
import { isDenied, requireAdminActor } from "@/lib/admin-auth";
import {
  getWebRecordsPool,
  reconnectWebRecordsRuntime,
} from "@/lib/records";

const MIN_LENGTH = 8;
const FORBIDDEN = new Set(["secret", "password", "postgres"]);

function isPlainPasswordSafe(password: string): boolean {
  // ALTER USER ... PASSWORD '...' takes a plain-text literal. Postgres
  // hashes it server-side. We refuse single quotes and backslashes so
  // the string can't escape the literal context. Most password managers
  // generate alnum + symbol passwords without these characters.
  return !/['\\\n\r\0]/.test(password);
}

function roleIdentifier(value: unknown, label: string): string {
  const role = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error(`${label} database role is not a safe Postgres identifier`);
  }
  return role;
}

async function rotateDatabaseRoles(password: string): Promise<void> {
  const metadata = await pool().connect();
  const records = await getWebRecordsPool().connect();
  const recordsRole = roleIdentifier(buildRecordsPoolConfig().user, "records");
  try {
    await metadata.query("begin");
    await records.query("begin");
    await metadata.query(`alter role neko with password '${password}'`);
    await records.query(`alter role ${recordsRole} with password '${password}'`);
    // Both ALTER ROLE statements are transactional. Keep both transactions
    // open until both statements have succeeded, then commit the records role
    // first so a metadata failure can still be reported through the live web
    // connection.
    await records.query("commit");
    await metadata.query("commit");
  } catch (error) {
    await Promise.allSettled([
      records.query("rollback"),
      metadata.query("rollback"),
    ]);
    throw error;
  } finally {
    records.release();
    metadata.release();
  }
}

export async function POST(request: NextRequest) {
  const allowed = await requireAdminActor();
  if (isDenied(allowed)) return allowed;
  try {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password.trim() : "";

    if (password.length < MIN_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_LENGTH} characters.` },
        { status: 400 },
      );
    }
    if (FORBIDDEN.has(password.toLowerCase())) {
      return NextResponse.json(
        { error: "That password is too common. Pick something else." },
        { status: 400 },
      );
    }
    if (!isPlainPasswordSafe(password)) {
      return NextResponse.json(
        { error: "Password contains characters we can't safely apply (quotes, backslashes, newlines)." },
        { status: 400 },
      );
    }

    // ALTER ROLE takes a literal; we vetted the string above because Postgres
    // does not accept a bind parameter in this DDL position.
    await rotateDatabaseRoles(password);

    writeLocalConfig({
      pg: { password },
      recordsPg: { password },
    });

    // Drain both pools so subsequent queries use the new password.
    await reconnectWebRecordsRuntime();
    await reconnectPool();

    // Tell the worker process to restart so its pg-boss singleton
    // (created at boot with old creds) gets rebuilt. Best-effort —
    // the worker may not be running yet during /setup, and that's fine.
    try {
      const workerAdminUrl = (process.env.WORKER_ADMIN_URL ?? "http://127.0.0.1:4100")
        .replace(/\/+$/, "");
      await fetch(`${workerAdminUrl}/admin/reconnect`, {
        method: "POST",
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // worker down / not yet listening / network blip — non-fatal
    }

    if (process.env.OPENNEKO_RESTART_WEB_ON_PASSWORD_CHANGE === "1") {
      setTimeout(() => process.exit(0), 250).unref();
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/admin/change-password — small status endpoint so the wizard
 * knows whether the password has already been changed (config file
 * has pg.password) without leaking the value.
 */
export async function GET() {
  const allowed = await requireAdminActor();
  if (isDenied(allowed)) return allowed;
  return NextResponse.json({ changed: hasCustomPassword() });
}
