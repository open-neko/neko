import { NextRequest } from "next/server";
import {
  enforceWorkflowApiEdgeThrottle,
  getWorkflowApiRunStatus,
  parseWorkflowApiBearer,
} from "@neko/llm/workflows";
import {
  workflowApiErrorResponse,
  workflowApiFingerprint,
  workflowApiJson,
} from "@/lib/workflow-api-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ workflowId: string; runId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const fingerprint = workflowApiFingerprint(request);
  try {
    await enforceWorkflowApiEdgeThrottle(fingerprint);
    const { workflowId, runId } = await context.params;
    const token = parseWorkflowApiBearer(request.headers.get("authorization"));
    const run = await getWorkflowApiRunStatus({
      workflowId,
      runId,
      token: token ?? "",
      clientFingerprint: fingerprint,
    });
    return workflowApiJson(
      {
        ...run,
        createdAt: run.createdAt.toISOString(),
        admittedAt: run.admittedAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        expiresAt: run.expiresAt.toISOString(),
      },
      {
        headers: run.retryAfterSeconds
          ? { "Retry-After": String(run.retryAfterSeconds) }
          : undefined,
      },
    );
  } catch (error) {
    return workflowApiErrorResponse(error);
  }
}
