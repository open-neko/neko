import Link from "next/link";
import { CircleAlert } from "lucide-react";

export function RecordsDegradedBanner({ message }: { message: string }) {
  return (
    <div className="records-degraded" role="alert">
      <CircleAlert aria-hidden="true" />
      <span>
        <strong>Records are unavailable.</strong> {message} No fallback database read was attempted.
      </span>
      <Link href="/admin">Open health settings</Link>
    </div>
  );
}

export function RecordsUnavailable({ message }: { message: string }) {
  return (
    <main className="records-root">
      <RecordsDegradedBanner message={message} />
      <section className="records-unavailable-panel">
        <span className="records-eyebrow">Protected data plane</span>
        <h1>This app is paused</h1>
        <p>OpenNeko will not bypass GraphJin or query application tables directly while records are degraded.</p>
      </section>
    </main>
  );
}

