import type { CapabilityProfile, InteractionEvent, Projection } from "@neko/interaction";
import { clampChars, summarizeBody } from "./degrade";

/**
 * Telegram Bot API projection. Telegram's rich formatting (parse_mode) is far
 * leaner than Slack Block Kit or web A2UI: it carries a single formatted text
 * message plus an optional inline keyboard, no card/column layout. We target
 * `parse_mode: "HTML"` — safer to generate than MarkdownV2 (only `& < >` need
 * escaping, vs MarkdownV2's ~18 reserved chars) and decoded identically in
 * every client.
 *
 * Telegram HTML supports ONLY: b, i, u, s, code, pre, a, blockquote, spoiler,
 * tg-emoji, and recognizes only the &amp; &lt; &gt; &quot; entities. No
 * headings, lists, or tables — so Markdown headings degrade to a bold line and
 * list items to bullet lines.
 *
 * Branch only on `profile` (capabilities), never on the channel's identity.
 */

export type TelegramParseMode = "HTML";

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramProjectionResult {
  /** Message text — HTML when `parseMode` is set, otherwise plain. */
  text: string;
  parseMode?: TelegramParseMode;
  /** Inline keyboard for approvals / quick replies. */
  replyMarkup?: { inline_keyboard: TelegramInlineButton[][] };
}

/** Telegram HTML decodes only `&amp; &lt; &gt; &quot;` — NOT `&apos;` — so we
 *  escape just the three structural chars (don't reuse degrade's XML escaper,
 *  which emits `&apos;`). */
export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Private-use-area sentinels: code spans + links are stashed behind these
// BEFORE escaping/emphasis, so their content is never re-parsed and an ordinary
// number in the text (e.g. "$4.7M") is never mistaken for a stash index.
// escapeHtml leaves the sentinels untouched.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const STASH_RE = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

// Inline spans for ONE line: stash code + links, escape, then emphasis.
const inlineMd = (text: string): string => {
  const stash: string[] = [];
  const keep = (fragment: string): string => {
    stash.push(fragment);
    return `${OPEN}${stash.length - 1}${CLOSE}`;
  };
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => keep(`<code>${escapeHtml(c)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    keep(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`),
  );
  s = escapeHtml(s);
  // bold before italic; skip single `_` italic so snake_case identifiers survive.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  return s.replace(STASH_RE, (_m, n: string) => stash[Number(n)] ?? "");
};

/**
 * Convert the Markdown subset agents emit into Telegram-flavoured HTML.
 * Unsupported blocks degrade: headings → bold line, list items → bullet line,
 * horizontal rules → an em dash.
 */
export const mdToTelegramHtml = (md: string): string => {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let quote: string[] | null = null;
  const flushQuote = () => {
    if (quote && quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushQuote();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      const body = escapeHtml(code.join("\n"));
      out.push(fence[1] ? `<pre><code class="language-${fence[1]}">${body}</code></pre>` : `<pre>${body}</pre>`);
      continue;
    }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      (quote ??= []).push(inlineMd(bq[1] ?? ""));
      i++;
      continue;
    }
    flushQuote();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`<b>${inlineMd(heading[1] ?? "")}</b>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("—");
      i++;
      continue;
    }
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      out.push(`• ${inlineMd(li[1] ?? "")}`);
      i++;
      continue;
    }
    out.push(line.trim() === "" ? "" : inlineMd(line));
    i++;
  }
  flushQuote();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const MOOD_DOT: Record<string, string> = { good: "🟢", watch: "🟡", act: "🔴" };

const metricLine = (label: string, value: string, sub?: string): string =>
  `<b>${escapeHtml(value)}</b> — ${escapeHtml(label)}${sub ? ` <i>(${escapeHtml(sub)})</i>` : ""}`;

export const telegramProjection: Projection<TelegramProjectionResult> = (events, profile) => {
  const html = profile.richMedia.markdown;
  const parts: string[] = [];
  const keyboard: TelegramInlineButton[][] = [];
  const fmt = (text: string): string => (html ? mdToTelegramHtml(text) : text);

  for (const event of events) {
    if (event.kind === "converse") {
      parts.push(fmt(event.text));
    } else if (event.kind === "inform") {
      const body = summarizeBody(event.body, profile.fidelity);
      const head = html ? `${MOOD_DOT[event.mood] ?? ""} <b>${escapeHtml(event.title)}</b>`.trim() : event.title;
      const lines = [head];
      if (event.metric) {
        lines.push(
          html
            ? metricLine(event.metric.label, event.metric.value, event.metric.sub)
            : `${event.metric.value} — ${event.metric.label}`,
        );
      }
      if (body) lines.push(fmt(body));
      if (event.series && !profile.richMedia.charts) {
        lines.push(html ? "<i>📊 Chart available in the web dashboard.</i>" : "📊 Chart available in the web dashboard.");
      }
      parts.push(lines.join("\n"));
    } else if (event.kind === "highlight") {
      const head = html ? "<b>Key figures</b>" : "Key figures";
      const items = event.metrics.map((m) =>
        html
          ? `• ${metricLine(m.label, m.value, m.sub)}`
          : `• ${m.value} — ${m.label}${m.sub ? ` (${m.sub})` : ""}`,
      );
      parts.push([head, ...items].join("\n"));
    } else if (event.kind === "resolve") {
      const mark = event.status === "succeeded" ? "✓" : event.status === "rejected" ? "⊘" : "✗";
      parts.push(html ? `${mark} <i>${escapeHtml(event.summary)}</i>` : `${mark} ${event.summary}`);
    } else if (event.kind === "offer") {
      parts.push(
        html
          ? `📎 <a href="${escapeHtml(event.artifactRef)}">${escapeHtml(event.label)}</a>`
          : `📎 ${event.label}: ${event.artifactRef}`,
      );
    } else if (event.kind === "ask") {
      parts.push(fmt(event.prompt));
      if (!profile.interaction.canApproveInline) {
        parts.push(html ? "<i>Open the web dashboard to respond.</i>" : "Open the web dashboard to respond.");
      } else if (event.ask === "choice" && event.options?.length) {
        for (const option of event.options) {
          keyboard.push([{ text: option.label, callback_data: `select:${event.decisionRef}:${option.id}` }]);
        }
      } else if (event.ask === "approval") {
        keyboard.push([
          { text: "✅ Approve", callback_data: `approve:${event.decisionRef}` },
          { text: "✖️ Reject", callback_data: `reject:${event.decisionRef}` },
        ]);
      }
    }
    // `progress` is transient — never sent to a push channel.
  }

  const text = clampChars(parts.filter(Boolean).join("\n\n"), profile.constraints.maxOutboundChars);
  const result: TelegramProjectionResult = { text };
  if (html) result.parseMode = "HTML";
  if (keyboard.length) result.replyMarkup = { inline_keyboard: keyboard };
  return result;
};
