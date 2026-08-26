import { z } from "zod";
import type { AgentSurfaceMessage } from "../agent-backend";

export const A2UI_VERSION = "v1.0" as const;
export const A2UI_CATALOG_ID = "urn:openneko:catalog:work:v2" as const;
export const A2UI_RENDER_SERVER_NAME = "neko_ui" as const;
export const A2UI_RENDER_TOOL_NAME = "render_cards" as const;

/**
 * Hermes reports tools from the multiplexed `neko` bridge as
 * `mcp_neko_<logical-server>_<tool>` in ACP notifications.
 */
export const A2UI_RENDER_ACP_TITLE =
  "mcp_neko_ui_render_cards" as const;

const a2uiComponentSchema = z
  .object({ id: z.string().min(1), component: z.string().min(1) })
  .passthrough();

function messageSchema(opts: { generated: boolean }) {
  const version = opts.generated
    ? z.literal(A2UI_VERSION)
    : z.enum(["v0.9", A2UI_VERSION]);
  const catalogId = opts.generated
    ? z.literal(A2UI_CATALOG_ID)
    : z.string().min(1);

  const createSurfaceSchema = z
    .object({
      version,
      createSurface: z
        .object({
          surfaceId: z.string().min(1),
          catalogId,
          surfaceProperties: z.record(z.string(), z.unknown()).optional(),
          sendDataModel: z.boolean().optional(),
          components: z.array(a2uiComponentSchema).min(1).optional(),
          dataModel: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    })
    .strict();
  const updateComponentsSchema = z
    .object({
      version,
      updateComponents: z
        .object({
          surfaceId: z.string().min(1),
          components: z.array(a2uiComponentSchema).min(1),
        })
        .strict(),
    })
    .strict();
  const updateDataModelSchema = z
    .object({
      version,
      updateDataModel: z
        .object({
          surfaceId: z.string().min(1),
          path: z.string().optional(),
          value: z.unknown().optional(),
        })
        .strict(),
    })
    .strict();
  const deleteSurfaceSchema = z
    .object({
      version,
      deleteSurface: z.object({ surfaceId: z.string().min(1) }).strict(),
    })
    .strict();

  return z.union([
    createSurfaceSchema,
    updateComponentsSchema,
    updateDataModelSchema,
    deleteSurfaceSchema,
  ]);
}

/** The sole schema for newly generated A2UI messages. */
export const generatedA2UIMessageSchema = messageSchema({ generated: true });

/** Reader compatibility for already-persisted v0.9 surfaces. */
const readableA2UIMessageSchema = messageSchema({ generated: false });

/** The sole schema accepted by the render_cards tool. */
export const renderCardsArgsSchema = z
  .object({
    messages: z.array(generatedA2UIMessageSchema).min(1),
  })
  .strict();

export const RENDER_CARDS_INPUT_SHAPE = renderCardsArgsSchema.shape;

/** JSON Schema is generated from the validator instead of maintained by hand. */
export const RENDER_CARDS_INPUT_SCHEMA = z.toJSONSchema(
  renderCardsArgsSchema,
) as Record<string, unknown>;

export type RenderCardsArgs = z.infer<typeof renderCardsArgsSchema>;

export type RenderInputValidation =
  | { success: true; messages: AgentSurfaceMessage[] }
  | {
      success: false;
      issues: Array<{ path: string; code: string; message: string }>;
    };

/** Validate the complete tool argument object. Invalid messages reject the call. */
export function validateRenderCardsInput(value: unknown): RenderInputValidation {
  const parsed = renderCardsArgsSchema.safeParse(value);
  if (parsed.success) {
    return {
      success: true,
      messages: parsed.data.messages as AgentSurfaceMessage[],
    };
  }
  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  };
}

/** Validate parsed reader input while retaining v0.9 history compatibility. */
export function coerceReadableSurfaceMessages(
  value: unknown,
): AgentSurfaceMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const parsed = readableA2UIMessageSchema.safeParse(message);
    return parsed.success ? [parsed.data as AgentSurfaceMessage] : [];
  });
}

/** Validate parsed model output. New render calls are v1.0 only. */
export function coerceGeneratedSurfaceMessages(
  value: unknown,
): AgentSurfaceMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const parsed = generatedA2UIMessageSchema.safeParse(message);
    return parsed.success ? [parsed.data as AgentSurfaceMessage] : [];
  });
}
