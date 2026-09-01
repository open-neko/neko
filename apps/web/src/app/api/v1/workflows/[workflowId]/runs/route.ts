import { NextRequest } from "next/server";
import {
  WorkflowApiError,
  admitWorkflowApiRun,
  enforceWorkflowApiEdgeThrottle,
  parseWorkflowApiBearer,
  type WorkflowApiExecutionMode,
} from "@neko/llm/workflows";
import {
  workflowApiErrorResponse,
  workflowApiFingerprint,
  workflowApiJson,
  readWorkflowApiJsonBody,
} from "@/lib/workflow-api-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ workflowId: string }>;
};

function parseMode(request: NextRequest): WorkflowApiExecutionMode {
  const value = request.nextUrl.searchParams.get("mode");
  if (value === null || value === "single") return "single";
  if (value === "batch") return "batch";
  throw new WorkflowApiError(
    "invalid_mode",
    "mode must be 'single' or 'batch'.",
    400,
  );
}

export async function POST(request: NextRequest, context: RouteContext) {
  const fingerprint = workflowApiFingerprint(request);
  try {
    await enforceWorkflowApiEdgeThrottle(fingerprint);
    const { workflowId } = await context.params;
    const mode = parseMode(request);
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
    if (contentType !== "application/json") {
      throw new WorkflowApiError(
        "unsupported_media_type",
        "Content-Type must be application/json.",
        415,
      );
    }
    const value = await readWorkflowApiJsonBody(request);
    const token = parseWorkflowApiBearer(request.headers.get("authorization"));
    const idempotencyKey = request.headers.get("idempotency-key");
    const admitted = await admitWorkflowApiRun({
      workflowId,
      token: token ?? "",
      idempotencyKey: idempotencyKey ?? "",
      mode,
      value,
      clientFingerprint: fingerprint,
    });
    return workflowApiJson(
      {
        runId: admitted.runId,
        status: admitted.status,
        mode: admitted.mode,
        replay: admitted.replay,
        statusUrl: admitted.statusUrl,
        expiresAt: admitted.expiresAt.toISOString(),
      },
      {
        status: 202,
        headers: {
          Location: admitted.statusUrl,
          "Retry-After": admitted.status === "queued" ? "3" : "1",
        },
      },
    );
  } catch (error) {
    return workflowApiErrorResponse(error);
  }
}
