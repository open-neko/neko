"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, LoaderCircle, MessageCircle } from "lucide-react";
import {
  buildRecordAskSeed,
  recordAskThreadTitle,
  type RecordAskContext,
} from "@/lib/record-ask";

export function RecordAskBox({ context }: { context: RecordAskContext }) {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = context.surface === "detail" || context.surface === "recycle_detail";
  const subject = detail ? "this record" : "these records";

  async function openAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = request.trim();
    if (!message || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/work/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: recordAskThreadTitle(context) }),
      });
      if (!response.ok) throw new Error("Could not open Ask");
      const payload = (await response.json()) as { thread?: { id?: string } };
      if (!payload.thread?.id) throw new Error("Ask did not return a thread");
      const seed = buildRecordAskSeed(context, message);
      router.push(`/work/${payload.thread.id}?seed=${encodeURIComponent(seed)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open Ask");
      setSubmitting(false);
    }
  }

  return (
    <section className="records-ask" aria-label={`Ask OpenNeko about ${subject}`}>
      <div className="records-ask-label">
        <MessageCircle aria-hidden="true" />
        <span>
          <strong>Ask about {subject}</strong>
          <small>Reads use your access. Changes still require policy approval.</small>
        </span>
      </div>
      <form onSubmit={openAsk}>
        <label className="sr-only" htmlFor={`records-ask-${context.surface}`}>
          Ask OpenNeko about {subject}
        </label>
        <input
          id={`records-ask-${context.surface}`}
          value={request}
          onChange={(event) => {
            setRequest(event.target.value);
            if (error) setError(null);
          }}
          placeholder={
            detail
              ? "Summarize, update, or investigate this record…"
              : "Find, compare, or change a record…"
          }
          maxLength={2_000}
          disabled={submitting}
        />
        <button
          type="submit"
          disabled={!request.trim() || submitting}
          aria-label={submitting ? "Opening Ask" : "Open Ask"}
        >
          {submitting ? (
            <LoaderCircle className="records-spin" aria-hidden="true" />
          ) : (
            <ArrowUp aria-hidden="true" />
          )}
        </button>
      </form>
      {error && <span className="records-ask-error" role="alert">{error}</span>}
    </section>
  );
}
