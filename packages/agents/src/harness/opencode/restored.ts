import type { AgentSessionId, OperatorMessageId } from "@usine/core/agent/session";
import { Effect } from "effect";
import type { QueuedOperatorMessage } from "../../runtime.ts";
import type { OpenCodeApi } from "./api.ts";
import { Inbox, openCodeMessageId } from "./codec.ts";

/**
 * Where the unread operator messages restored from the journal stand in a session whose bridge the
 * process owner retained, so events and posts lost before the restart don't count.
 */
export interface RestoredInput {
  /** The messages that OpenCode delivered into the session's history. */
  readonly delivered: ReadonlyArray<OperatorMessageId>;
  /** The messages that OpenCode holds in the session's inbox. */
  readonly queued: ReadonlyArray<OperatorMessageId>;
  /** The messages that OpenCode never received, which the session sends again. */
  readonly lost: ReadonlyArray<QueuedOperatorMessage>;
}

/**
 * Looks up each of the `unread` operator messages of `sessionId` in OpenCode session `session`. It
 * reads the inbox first: OpenCode moves an item from the inbox into the history when it delivers
 * it, so a message found in neither afterwards was never posted.
 */
export const restoredInput = Effect.fn("OpenCodeRuntime.restoredInput")(function* (
  api: OpenCodeApi,
  session: string,
  sessionId: AgentSessionId,
  unread: ReadonlyArray<QueuedOperatorMessage>,
) {
  yield* Effect.annotateCurrentSpan({ sessionId, harnessSessionId: session });
  if (unread.length === 0) return { delivered: [], queued: [], lost: [] } satisfies RestoredInput;
  const inbox = yield* api.read(
    Inbox,
    "launch",
    "GET",
    `/api/session/${encodeURIComponent(session)}/inbox`,
  );
  const inInbox = new Set(inbox.data.map(({ id }) => id));
  const delivered: Array<OperatorMessageId> = [];
  const queued: Array<OperatorMessageId> = [];
  const lost: Array<QueuedOperatorMessage> = [];
  for (const message of unread) {
    const inputId = openCodeMessageId(sessionId, message.id);
    if (inInbox.has(inputId)) queued.push(message.id);
    else if (yield* api.messageDelivered(session, inputId)) delivered.push(message.id);
    else lost.push(message);
  }
  yield* Effect.logInfo("Reconciled the restored operator messages with the retained session", {
    sessionId,
    delivered: delivered.length,
    queued: queued.length,
    lost: lost.length,
  });
  return { delivered, queued, lost } satisfies RestoredInput;
});
