const HOUR_MS = 60 * 60 * 1_000;

export function metricCadenceMs(cadence: string): number {
  switch (cadence.trim().toLowerCase()) {
    case "hourly":
      return HOUR_MS;
    case "weekly":
      return 7 * 24 * HOUR_MS;
    case "daily":
    default:
      // Unknown legacy values fall back to the prior daily behavior instead
      // of creating an accidental high-frequency refresh loop.
      return 24 * HOUR_MS;
  }
}

export function metricRefreshIsDue(input: {
  cadence: string;
  lastRefreshStatus: string | null;
  updatedAt: Date;
  now?: Date;
}): boolean {
  if (input.lastRefreshStatus === "pending") return false;
  const now = input.now ?? new Date();
  return input.updatedAt.getTime() + metricCadenceMs(input.cadence) <= now.getTime();
}
