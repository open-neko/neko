import type { A2UIMessage } from "@/a2ui/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

export function isA2UIMessage(value: unknown): value is A2UIMessage {
  if (!isRecord(value) || (value.version !== "v0.9" && value.version !== "v1.0")) {
    return false;
  }

  if (isRecord(value.createSurface)) {
    return (
      hasString(value.createSurface, "surfaceId") &&
      hasString(value.createSurface, "catalogId")
    );
  }
  if (isRecord(value.updateComponents)) {
    return (
      hasString(value.updateComponents, "surfaceId") &&
      Array.isArray(value.updateComponents.components)
    );
  }
  if (isRecord(value.updateDataModel)) {
    return hasString(value.updateDataModel, "surfaceId");
  }
  if (isRecord(value.deleteSurface)) {
    return hasString(value.deleteSurface, "surfaceId");
  }
  return false;
}

export async function readBriefingMessages(response: Response): Promise<A2UIMessage[]> {
  if (!response.ok) {
    throw new Error(`Briefing request failed (HTTP ${response.status})`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body) || !body.every(isA2UIMessage)) {
    throw new Error("Briefing response was not a valid A2UI message sequence");
  }
  return body;
}
