import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import {
  enforceWorkflowApiEdgeThrottle,
  getWorkflowApiArtifact,
  parseWorkflowApiBearer,
} from "@neko/llm/workflows";
import {
  workflowApiErrorResponse,
  workflowApiFingerprint,
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
    const artifact = await getWorkflowApiArtifact({
      workflowId,
      runId,
      token: token ?? "",
      clientFingerprint: fingerprint,
    });
    const body = Readable.toWeb(createReadStream(artifact.absolutePath));
    return new NextResponse(body as ReadableStream, {
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Length": String(artifact.bytes),
        "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return workflowApiErrorResponse(error);
  }
}
