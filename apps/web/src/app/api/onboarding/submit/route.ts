import { NextRequest, NextResponse } from "next/server";
import {
  db,
  eq,
  onboarding_wizard,
  organization,
  processing_job,
} from "@neko/db";
import { enqueue, QUEUE } from "@neko/db/jobs";
import { getOrgId } from "@/lib/db";
import {
  AGENT_RUNTIME_UNAVAILABLE_CODE,
  AgentRuntimeUnavailableError,
  requireAgentRuntimeReady,
} from "@/lib/agent-runtime-readiness";
import { hasPrimaryProviderSetup } from "@/lib/provider-settings";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    companyName,
    companyNote,
    fiscalYearStartMonth,
    activeSeats,
    priorities,
  } = body as {
    companyName: string;
    companyNote: string;
    fiscalYearStartMonth: number;
    activeSeats: string[];
    priorities: string[];
  };

  const trimmedName = typeof companyName === "string" ? companyName.trim() : "";
  if (!trimmedName) {
    return NextResponse.json(
      { error: "companyName is required" },
      { status: 400 },
    );
  }

  const orgId = await getOrgId();

  if (!(await hasPrimaryProviderSetup(orgId))) {
    return NextResponse.json(
      {
        error:
          "The primary model provider is not configured. Open Agent settings, save a provider, then try again.",
        code: "primary_provider_unavailable",
      },
      { status: 409 },
    );
  }

  try {
    await requireAgentRuntimeReady(orgId);
  } catch (error) {
    if (error instanceof AgentRuntimeUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: AGENT_RUNTIME_UNAVAILABLE_CODE },
        { status: 503 },
      );
    }
    throw error;
  }

  await db()
    .update(organization)
    .set({ name: trimmedName, updated_at: new Date() })
    .where(eq(organization.id, orgId));

  await db().delete(onboarding_wizard).where(eq(onboarding_wizard.org_id, orgId));
  await db().insert(onboarding_wizard).values({
    org_id: orgId,
    company_note: companyNote,
    fiscal_year_start_month: fiscalYearStartMonth,
    active_seats: activeSeats,
    priorities,
    step: "submitting",
    submitted_at: new Date(),
  });

  const inserted = await db()
    .insert(processing_job)
    .values({
      org_id: orgId,
      kind: "business_profile_build",
      status: "queued",
      trigger: "wizard_submit",
    })
    .returning({ id: processing_job.id });
  const jobId = inserted[0]?.id;
  if (!jobId) {
    return NextResponse.json(
      { error: "failed to record job" },
      { status: 500 },
    );
  }
  try {
    // The UI already waits through the profiler's bounded agent attempt.
    // Hidden queue retries make onboarding look stuck after a known failure.
    await enqueue(
      QUEUE.BUSINESS_PROFILE_BUILD,
      {
        processingJobId: jobId,
        orgId,
      },
      { retryLimit: 0 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db()
      .update(processing_job)
      .set({
        status: "failed",
        error: `enqueue failed: ${msg}`,
        finished_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(processing_job.id, jobId));
    return NextResponse.json(
      { error: `enqueue failed: ${msg}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ jobId });
}
