import { describe, expect, it } from "vitest";
import {
  EMAIL_DIGEST_PROFILE,
  SLACK_PROFILE,
  TELEGRAM_PROFILE,
  VOICE_PROFILE,
  WEB_PROFILE,
  type InteractionEvent,
} from "@neko/interaction";
import {
  intentFromButtonId,
  mdToTelegramHtml,
  slackProjection,
  telegramProjection,
  voiceProjection,
  webProjection,
  type SlackBlock,
} from "../src/index.js";

const inform: InteractionEvent = {
  kind: "inform",
  id: "o1",
  mood: "good",
  title: "Q3 revenue landed",
  body: "Revenue hit $4.7M, up 12% MoM. Strong enterprise pull this quarter.",
  metric: { label: "Revenue MTD", value: "$4.7M" },
  series: { kind: "line", points: [{ d: "Mon", v: 1 }, { d: "Tue", v: 2 }] },
};

const ask: InteractionEvent = {
  kind: "ask",
  id: "a1",
  ask: "approval",
  prompt: "Approve $5k refund to ACME?",
  decisionRef: "ar-123",
  risk: "medium",
};

const highlight: InteractionEvent = {
  kind: "highlight",
  id: "h1",
  metrics: [
    { label: "Top-10 share", value: "48%", sub: "down from 53%" },
    { label: "YoY revenue", value: "+14%" },
  ],
};

const blockTypes = (blocks: SlackBlock[]): string[] => blocks.map((b) => String(b.type));

describe("one inform, every substrate (degradation by profile)", () => {
  it("web keeps the full card with chart data", () => {
    const { surfaces, pendingAsks } = webProjection([inform], WEB_PROFILE);
    const update = surfaces[1] as { updateComponents: { components: Array<Record<string, unknown>> } };
    const card = update.updateComponents.components[0]!;
    expect(card.component).toBe("MetricCard");
    expect(card.metric).toBe("$4.7M");
    expect((card.chartData as unknown[]).length).toBe(2);
    expect(pendingAsks).toHaveLength(0);
  });

  it("slack keeps the card but drops the chart to a note", () => {
    const { blocks } = slackProjection([inform], SLACK_PROFILE);
    const section = blocks[0] as { text: { text: string } };
    expect(section.text.text).toContain("Q3 revenue landed");
    expect(blockTypes(blocks)).toContain("context");
    expect(JSON.stringify(blocks)).toContain("Chart available");
    expect(JSON.stringify(blocks)).not.toContain("Tue");
  });

  it("voice speaks the headline and metric, no chart", () => {
    const { ssml } = voiceProjection([inform], VOICE_PROFILE);
    expect(ssml.startsWith("<speak>")).toBe(true);
    expect(ssml).toContain("Q3 revenue landed");
    expect(ssml).toContain("Revenue MTD is $4.7M");
    expect(ssml).not.toContain("Tue");
  });
});

describe("one highlight, every substrate renders the figures its own way", () => {
  it("web renders the figures as a markdown component", () => {
    const { surfaces } = webProjection([highlight], WEB_PROFILE);
    const update = surfaces[1] as { updateComponents: { components: Array<Record<string, unknown>> } };
    const comp = update.updateComponents.components[0]!;
    expect(comp.component).toBe("Markdown");
    expect(String(comp.text)).toContain("**48%** Top-10 share — down from 53%");
    expect(String(comp.text)).toContain("**+14%** YoY revenue");
  });

  it("slack renders the figures as section fields", () => {
    const { blocks } = slackProjection([highlight], SLACK_PROFILE);
    const json = JSON.stringify(blocks);
    expect(json).toContain("Key figures");
    expect(json).toContain("Top-10 share");
    expect(json).toContain("down from 53%");
  });

  it("voice reads the figures aloud, no sub when absent", () => {
    const { ssml } = voiceProjection([highlight], VOICE_PROFILE);
    expect(ssml).toContain("Top-10 share is 48%, down from 53%.");
    expect(ssml).toContain("YoY revenue is +14%.");
  });
});

describe("ask negotiation branches on profile, never on channel identity", () => {
  it("same slack projection yields buttons under an inline-capable profile", () => {
    const { blocks } = slackProjection([ask], SLACK_PROFILE);
    expect(blockTypes(blocks)).toContain("actions");
    expect(JSON.stringify(blocks)).toContain('"action_id":"approve"');
  });

  it("and yields a link-back under a read-only profile — same function", () => {
    const { blocks } = slackProjection([ask], EMAIL_DIGEST_PROFILE);
    expect(blockTypes(blocks)).not.toContain("actions");
    expect(JSON.stringify(blocks)).toContain("Open the web dashboard");
  });

  it("web surfaces the ask to its native approval UI", () => {
    const { pendingAsks } = webProjection([ask], WEB_PROFILE);
    expect(pendingAsks).toHaveLength(1);
    expect(pendingAsks[0]!.decisionRef).toBe("ar-123");
  });

  it("voice speaks the ask as a yes/no", () => {
    const { ssml } = voiceProjection([ask], VOICE_PROFILE);
    expect(ssml).toContain("Say approve or reject");
  });
});

describe("telegram projection — rich HTML formatting", () => {
  it("renders an inform as HTML: mood dot, bold title, metric line, body, chart note", () => {
    const res = telegramProjection([inform], TELEGRAM_PROFILE);
    expect(res.parseMode).toBe("HTML");
    expect(res.text).toContain("🟢 <b>Q3 revenue landed</b>");
    expect(res.text).toContain("<b>$4.7M</b> — Revenue MTD");
    expect(res.text).toContain("Chart available in the web dashboard");
    expect(res.replyMarkup).toBeUndefined();
  });

  it("approval ask yields Approve/Reject buttons whose callback_data round-trips to an intent", () => {
    const res = telegramProjection([ask], TELEGRAM_PROFILE);
    const [approve, reject] = res.replyMarkup!.inline_keyboard[0]!;
    expect(approve!.callback_data).toBe("approve:ar-123");
    expect(reject!.callback_data).toBe("reject:ar-123");
    expect(intentFromButtonId(approve!.callback_data)).toEqual({
      kind: "decision",
      decisionRef: "ar-123",
      choice: "approve",
    });
  });

  it("choice ask yields one button per option with select:ref:optId callback_data", () => {
    const choiceAsk: InteractionEvent = {
      kind: "ask",
      id: "a2",
      ask: "choice",
      prompt: "Which region?",
      decisionRef: "ar-9",
      options: [
        { id: "sw", label: "Southwest" },
        { id: "nw", label: "Northwest" },
      ],
    };
    const res = telegramProjection([choiceAsk], TELEGRAM_PROFILE);
    const kb = res.replyMarkup!.inline_keyboard;
    expect(kb).toHaveLength(2);
    expect(kb[0]![0]!.callback_data).toBe("select:ar-9:sw");
    expect(intentFromButtonId(kb[1]![0]!.callback_data)).toEqual({
      kind: "select",
      ref: "ar-9",
      optionId: "nw",
    });
  });

  it("highlight renders bullet metric lines", () => {
    const res = telegramProjection([highlight], TELEGRAM_PROFILE);
    expect(res.text).toContain("<b>Key figures</b>");
    expect(res.text).toContain("• <b>48%</b> — Top-10 share <i>(down from 53%)</i>");
  });

  it("clamps to the profile's maxOutboundChars (4096)", () => {
    const long: InteractionEvent = { kind: "converse", id: "c", role: "assistant", text: "x".repeat(5000) };
    const res = telegramProjection([long], TELEGRAM_PROFILE);
    expect(res.text.length).toBeLessThanOrEqual(4096);
  });

  it("sends plain text (no parse_mode) under a profile without markdown", () => {
    const plain = { ...TELEGRAM_PROFILE, richMedia: { ...TELEGRAM_PROFILE.richMedia, markdown: false } };
    const res = telegramProjection(
      [{ kind: "converse", id: "c", role: "assistant", text: "**hi**" }],
      plain,
    );
    expect(res.parseMode).toBeUndefined();
    expect(res.text).toBe("**hi**");
  });
});

describe("mdToTelegramHtml — Markdown subset → Telegram HTML", () => {
  it("converts bold, italic, inline code, strikethrough, and links", () => {
    expect(
      mdToTelegramHtml("**bold** and *italic* and `x=1` and ~~no~~ and [docs](https://e.com)"),
    ).toBe(
      '<b>bold</b> and <i>italic</i> and <code>x=1</code> and <s>no</s> and <a href="https://e.com">docs</a>',
    );
  });

  it("preserves numbers in the text — regression: '$4.7M' is not a stash index", () => {
    expect(mdToTelegramHtml("Revenue was **$4.7M** in Q3 across 12 regions.")).toBe(
      "Revenue was <b>$4.7M</b> in Q3 across 12 regions.",
    );
  });

  it("escapes < > & and never emits &apos;", () => {
    const html = mdToTelegramHtml("status < 5 && id > 0 won't break");
    expect(html).toContain("status &lt; 5 &amp;&amp; id &gt; 0");
    expect(html).not.toContain("&apos;");
  });

  it("does not italicize snake_case identifiers", () => {
    expect(mdToTelegramHtml("the sales_order_header table")).toBe("the sales_order_header table");
  });

  it("degrades headings to bold and list items to bullets", () => {
    const html = mdToTelegramHtml("## Summary\n- first\n- second\n1. third");
    expect(html).toContain("<b>Summary</b>");
    expect(html).toContain("• first");
    expect(html).toContain("• third");
    expect(html).not.toContain("##");
  });

  it("renders blockquotes and fenced code blocks, escaping HTML inside", () => {
    const html = mdToTelegramHtml("> a quote\n\n```sql\nselect 1 < 2\n```");
    expect(html).toContain("<blockquote>a quote</blockquote>");
    expect(html).toContain('<pre><code class="language-sql">select 1 &lt; 2</code></pre>');
  });

  it("escapes HTML inside an inline code span", () => {
    expect(mdToTelegramHtml("`a < b`")).toBe("<code>a &lt; b</code>");
  });
});
