import { redirect } from "next/navigation";
import {
  parseAppWorkContext,
  parseRecordWorkContext,
  type RecordWorkContext,
} from "@neko/llm/work";
import { getOrgId } from "@/lib/db";
import { getAuthorizedWorkThread } from "@/lib/work-thread-auth";

function appThreadHref(
  appId: string,
  threadId: string,
  recordContext: RecordWorkContext | null,
): string {
  const base = `/a/${encodeURIComponent(appId)}`;
  let path = base;
  if (recordContext?.appId === appId) {
    const object = encodeURIComponent(recordContext.objectApiName);
    if (recordContext.surface === "recycle_list") {
      path = `${base}/${object}/recycle`;
    } else if (recordContext.surface === "recycle_detail" && recordContext.recordId) {
      path = `${base}/${object}/recycle/${encodeURIComponent(recordContext.recordId)}`;
    } else if (recordContext.surface === "detail" && recordContext.recordId) {
      path = `${base}/${object}/${encodeURIComponent(recordContext.recordId)}`;
    } else {
      path = `${base}/${object}`;
    }
  }
  const query = new URLSearchParams({ chat: threadId });
  if (recordContext?.search) query.set("q", recordContext.search);
  if (recordContext?.myRecords) query.set("mine", "true");
  return `${path}?${query.toString()}`;
}

// App-owned and legacy records threads no longer render in the main Work UI.
// Bookmarks are re-homed into the owning app and select the same conversation.
export default async function WorkThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const [{ threadId }, orgId] = await Promise.all([params, getOrgId()]);
  const thread = await getAuthorizedWorkThread(orgId, threadId);
  if (!thread) return null;
  const state = thread.backend_state && typeof thread.backend_state === "object"
    && !Array.isArray(thread.backend_state)
    ? thread.backend_state as Record<string, unknown>
    : {};
  const appContext = parseAppWorkContext(state.appContext);
  const recordContext = parseRecordWorkContext(state.recordContext);
  const appId = appContext?.appId ?? recordContext?.appId;
  if (appId) redirect(appThreadHref(appId, threadId, recordContext));
  return null;
}
