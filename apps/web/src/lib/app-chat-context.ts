import "server-only";

import {
  parseRecordWorkContext,
  type AppWorkContext,
  type RecordWorkContext,
} from "@neko/llm/work";
import { getRecordAppNav } from "@/lib/records";

export class AppChatContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppChatContextError";
  }
}

export async function resolveAppChatContext(input: {
  orgId: string;
  appId: string;
  actorRole: "admin" | "member" | "service";
  recordContext: unknown;
}): Promise<{
  appContext: AppWorkContext;
  recordContext: RecordWorkContext | null;
}> {
  const app = await getRecordAppNav({
    orgId: input.orgId,
    appId: input.appId,
    role: input.actorRole === "member" ? "member" : "admin",
  });
  const appContext = { appId: app.appId, appLabel: app.label };
  if (input.recordContext === null || input.recordContext === undefined) {
    return { appContext, recordContext: null };
  }

  const parsed = parseRecordWorkContext(input.recordContext);
  if (!parsed || parsed.appId !== app.appId) {
    throw new AppChatContextError("Invalid app chat context");
  }
  const object = app.objects.find(
    (candidate) => candidate.apiName === parsed.objectApiName,
  );
  if (!object) throw new AppChatContextError("Invalid app chat context");

  const listSurface =
    parsed.surface === "list" || parsed.surface === "recycle_list";
  return {
    appContext,
    recordContext: {
      ...parsed,
      appId: app.appId,
      appLabel: app.label,
      objectApiName: object.apiName,
      objectLabel: listSurface ? object.pluralLabel : object.label,
    },
  };
}
