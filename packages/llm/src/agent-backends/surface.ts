import type { AgentSurfaceMessage } from "../agent-backend";

const NEKO_A2UI_FENCE_RE = /```neko_a2ui\s*([\s\S]*?)```/i;
const JSX_TAG_RE = /<\/?[A-Z][A-Za-z0-9]*\b[^>]*>/g;

// Mirror of isValidA2UIMessage in work/tools.ts so both backends apply the
// same validation before emitting `surface` events.
function isValidA2UIMessage(m: unknown): m is AgentSurfaceMessage {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  if (o.version !== "v0.9" && o.version !== "v1.0") return false;
  if (isRecord(o.createSurface)) {
    return hasString(o.createSurface, "surfaceId") && hasString(o.createSurface, "catalogId") &&
      (!Array.isArray(o.createSurface.components) || o.createSurface.components.every(isComponent));
  }
  if (isRecord(o.updateComponents)) {
    return hasString(o.updateComponents, "surfaceId") &&
      Array.isArray(o.updateComponents.components) && o.updateComponents.components.every(isComponent);
  }
  if (isRecord(o.updateDataModel)) return hasString(o.updateDataModel, "surfaceId");
  if (isRecord(o.deleteSurface)) return hasString(o.deleteSurface, "surfaceId");
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].length > 0;
}

function isComponent(value: unknown): boolean {
  return isRecord(value) && hasString(value, "id") && hasString(value, "component");
}

// Validate an already-parsed messages value (e.g. a render_cards tool call's
// `messages` argument) into surface messages. Returns [] when nothing valid.
export function coerceSurfaceMessages(value: unknown): AgentSurfaceMessage[] {
  return Array.isArray(value) ? value.filter(isValidA2UIMessage) : [];
}

/** New render_cards calls emit v1.0; v0.9 remains a reader-only format. */
export function coerceGeneratedSurfaceMessages(value: unknown): AgentSurfaceMessage[] {
  return coerceSurfaceMessages(value).filter((message) => message.version === "v1.0");
}

export function extractSurfaceMessages(raw: string): {
  text: string;
  messages: AgentSurfaceMessage[];
} {
  const match = raw.match(NEKO_A2UI_FENCE_RE);
  if (!match) return { text: raw.trim(), messages: [] };
  const outsideText = raw.replace(match[0], "").trim();
  const body = match[1].trim();
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      const messages = parsed.filter(isValidA2UIMessage);
      return { text: outsideText, messages };
    }
    // Non-array JSON falls through to synthetic markdown surface.
  } catch {
    // body wasn't JSON — fall through to synthetic markdown fallback
  }
  const proseFallback = body.replace(JSX_TAG_RE, "").trim();
  if (!proseFallback) return { text: outsideText, messages: [] };
  return {
    text: outsideText,
    messages: synthesizeMarkdownSurface(proseFallback),
  };
}

function synthesizeMarkdownSurface(text: string): AgentSurfaceMessage[] {
  const surfaceId = "fallback";
  return [
    {
      version: "v1.0",
      createSurface: {
        surfaceId,
        catalogId: "urn:openneko:catalog:work:v2",
        components: [{ id: "root", component: "Markdown", text }],
      },
    } as AgentSurfaceMessage,
  ];
}
