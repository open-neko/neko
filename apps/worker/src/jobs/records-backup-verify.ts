import { publishRecordsOpsFinding } from "./records-ops-finding.js";

export type BackupVerificationReport = {
  format: "openneko.backup-verification.v1";
  status: "succeeded";
  backup_set: string;
  completed_at: string;
  databases: Array<{
    stanza: string;
    probe: Record<string, unknown>;
  }>;
  config_snapshot: Record<string, unknown>;
};

export type BackupVerificationFinding = {
  status: "succeeded" | "failed";
  title: string;
  body: string;
  mood: "good" | "act";
  payload: Record<string, unknown>;
};

export type BackupVerificationDependencies = {
  verify: () => Promise<BackupVerificationReport>;
  publish: (orgId: string, finding: BackupVerificationFinding) => Promise<void>;
};

function asVerificationReport(value: unknown): BackupVerificationReport {
  if (!value || typeof value !== "object") {
    throw new Error("backup verification returned an invalid report");
  }
  const report = value as Partial<BackupVerificationReport>;
  if (
    report.format !== "openneko.backup-verification.v1" ||
    report.status !== "succeeded" ||
    typeof report.backup_set !== "string" ||
    typeof report.completed_at !== "string" ||
    !Array.isArray(report.databases) ||
    report.databases.length !== 2
  ) {
    throw new Error("backup verification did not prove both database restores");
  }
  return report as BackupVerificationReport;
}

export async function requestBackupVerification(): Promise<BackupVerificationReport> {
  const baseUrl = (process.env.OPENNEKO_BACKUP_URL ?? "http://127.0.0.1:9470").replace(
    /\/+$/,
    "",
  );
  const response = await fetch(`${baseUrl}/v1/backups/verify`, {
    method: "POST",
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`backup verification returned non-JSON (${response.status})`);
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : `HTTP ${response.status}`;
    throw new Error(`backup verification failed: ${message.slice(0, 2000)}`);
  }
  return asVerificationReport(payload);
}

export async function publishBackupVerificationFinding(
  orgId: string,
  finding: BackupVerificationFinding,
): Promise<void> {
  await publishRecordsOpsFinding(orgId, {
    ...finding,
    scope: "openneko_ops_backup",
    topic: "restore_verification",
    freshnessTtlSeconds: 8 * 24 * 60 * 60,
  });
}

export const defaultBackupVerificationDependencies: BackupVerificationDependencies = {
  verify: requestBackupVerification,
  publish: publishBackupVerificationFinding,
};

export async function runRecordsBackupVerification(
  orgId: string,
  dependencies: BackupVerificationDependencies = defaultBackupVerificationDependencies,
): Promise<BackupVerificationReport> {
  try {
    const report = await dependencies.verify();
    await dependencies.publish(orgId, {
      status: "succeeded",
      title: "Whole-deployment restore verification passed",
      body: `Backup set ${report.backup_set} restored both databases and decrypted its configuration snapshot successfully.`,
      mood: "good",
      payload: report as unknown as Record<string, unknown>,
    });
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dependencies.publish(orgId, {
      status: "failed",
      title: "Backup restore verification failed",
      body: message.slice(0, 4000),
      mood: "act",
      payload: { status: "failed", error: message.slice(0, 4000) },
    });
    throw error;
  }
}
