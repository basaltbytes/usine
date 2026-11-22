import type { AgentSessionId, HarnessSession, OperatorMessageId } from "@usine/core/agent/session";
import { Array as Arr, Effect, Option, Schema } from "effect";
import {
  AgentMessageItem,
  isMessagePhase,
  isToolStatus,
  isTurnStatus,
  ThreadResumeParams,
  ThreadResumeResponse,
  type ToolItem,
  UserMessageItem,
} from "../../protocol/codex/codex.ts";
import type { RestartState } from "../../runtime.ts";
import { checkContinuation } from "../continuation.ts";
import type { SessionSpec, Start } from "../contract.ts";
import type { RestoredItems } from "../conversation.ts";
import { type CodexClient, type CodexConnection, operationError } from "./app-server.ts";
import {
  AgentMessageKindItem,
  type CodexInput,
  decodeItem,
  decodeResponse,
  decodeToolItem,
  UserMessageKindItem,
} from "./codec.ts";

/** A turn of the thread that `thread/resume` returned. */
export type RestoredTurn = (typeof ThreadResumeResponse.Type.thread.turns)[number];

/** The turns of a Codex thread when the session opened it; a new thread has neither. */
interface ThreadTurns {
  /** The turn that was still running. */
  readonly activeTurn: Option.Option<RestoredTurn>;
  readonly lastTurn: Option.Option<RestoredTurn>;
}

export const resumeThread = Effect.fn("CodexRuntime.resumeThread")(function* (
  connection: CodexConnection,
  client: CodexClient,
  spec: SessionSpec,
  saved: HarnessSession,
) {
  const params: ThreadResumeParams = {
    threadId: saved.id,
    model: spec.session.brain.model,
    cwd: spec.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    excludeTurns: false,
  };
  const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(ThreadResumeParams))(params).pipe(
    Effect.orDie,
  );
  const response = yield* connection.request("launch", "thread/resume", encoded);
  const restored = yield* decodeResponse(
    ThreadResumeResponse,
    "launch",
    client,
    "thread resume response",
    response,
  );
  if (restored.thread.id !== saved.id)
    return yield* operationError(
      "launch",
      client,
      "Codex resumed a different thread",
      restored.thread.id,
    );
  if (Option.isSome(saved.modelProvider))
    yield* checkContinuation(
      spec,
      "model_provider",
      saved.modelProvider,
      Option.some(restored.modelProvider),
    );
  yield* Effect.logInfo("Resumed the saved Codex thread", {
    sessionId: spec.session.id,
    threadId: saved.id,
  });
  return {
    id: saved.id,
    empty: restored.thread.turns.length === 0,
    model: spec.session.brain.model,
    endpoint: Option.some(restored.modelProvider),
    activeTurn: Option.fromUndefinedOr(
      restored.thread.turns.find((turn) => isTurnStatus(turn.status, "inProgress")),
    ),
    lastTurn: Option.fromUndefinedOr(restored.thread.turns.at(-1)),
  };
});

/** Decodes the `userMessage` items of `turn`. */
const userMessages = (sessionId: AgentSessionId, turn: RestoredTurn) =>
  Effect.forEach(turn.items.filter(Schema.is(UserMessageKindItem)), (item) =>
    decodeItem(UserMessageItem, "user message", sessionId, item),
  ).pipe(Effect.map(Arr.getSomes));

/**
 * Reads what a Codex session restores from the thread that it opened: the running turn's tool
 * calls, by item ID, and agent messages, and the user-message items that the session counted.
 * `receiptsKnown` is false for a resumed session that saved no items, whose restored items then
 * acknowledge no input.
 */
export const restoredState = Effect.fn("CodexRuntime.restoredState")(function* (
  sessionId: AgentSessionId,
  thread: ThreadTurns,
  start: Start,
  restored: RestartState,
  toolName: (item: typeof ToolItem.Type) => string,
) {
  yield* Effect.annotateCurrentSpan({ sessionId });
  const running = Option.match(thread.activeTurn, {
    onNone: () => [],
    onSome: (turn) => turn.items,
  });
  const resumedTools = yield* Effect.forEach(running, (item) =>
    decodeToolItem(sessionId, item),
  ).pipe(Effect.map(Arr.getSomes));
  // The user-message items counted before a restart already acknowledged their input.
  const counted = Option.getOrElse(restored.receipts, () => []);
  const receiptsKnown = start._tag !== "StartResume" || Option.isSome(restored.receipts);
  // Without saved items, the active turn's items go in the next save, but their replayed
  // notifications still acknowledge inputs.
  const preserved = yield* Option.match(receiptsKnown ? Option.none() : thread.activeTurn, {
    onNone: () => Effect.succeedNone,
    onSome: (turn) =>
      Effect.map(userMessages(sessionId, turn), (messages) =>
        Option.some({ turn: turn.id, items: messages.map(({ id }) => id) }),
      ),
  });
  if (Option.isSome(preserved))
    yield* Effect.logInfo("Preserving the active Codex turn's existing receipt IDs", {
      sessionId,
      turnId: preserved.value.turn,
      items: preserved.value.items.length,
    });
  const items: RestoredItems = Option.match(preserved, {
    onNone: () => ({
      counted,
      turn: Option.map(thread.lastTurn, (turn) => turn.id),
      saved: counted,
    }),
    onSome: ({ turn, items: saved }) => ({ counted, turn: Option.some(turn), saved }),
  });
  const savedMessages = yield* Effect.forEach(running, (item) =>
    Schema.is(AgentMessageKindItem)(item)
      ? decodeItem(AgentMessageItem, "agent message", sessionId, item)
      : Effect.succeedNone,
  ).pipe(Effect.map((items) => Arr.getSomes(items).filter((item) => item.text.trim().length > 0)));
  const toolsInFlight: ReadonlyMap<string, string> = new Map(
    resumedTools
      .filter((item) => isToolStatus(item.status, "inProgress"))
      .map((item): [string, string] => [item.id, toolName(item)]),
  );
  return {
    items,
    receiptsKnown,
    toolsInFlight,
    lastText: Option.fromUndefinedOr(savedMessages.at(-1)?.text.trim()),
    finalText: Option.fromUndefinedOr(
      savedMessages
        .filter((item) => isMessagePhase(item.phase, "final_answer"))
        .at(-1)
        ?.text.trim(),
    ),
  };
});

/**
 * Acknowledges the unread messages that a restored thread's last turn, `turn`, records, so
 * recovery doesn't send them again. `known` is whether the session saved the user-message items
 * that it counted.
 */
export const readRestored = Effect.fn("CodexRuntime.readRestored")(function* <E>(
  sessionId: AgentSessionId,
  turn: RestoredTurn,
  known: boolean,
  conversation: {
    readonly unread: Effect.Effect<ReadonlyArray<unknown>>;
    readonly observe: (
      input: CodexInput,
    ) => Effect.Effect<
      { readonly read: ReadonlyArray<OperatorMessageId>; readonly repeated: number },
      E
    >;
  },
) {
  yield* Effect.annotateCurrentSpan({ sessionId, turnId: turn.id });
  const recorded = yield* userMessages(sessionId, turn);
  const unread = (yield* conversation.unread).length;
  const observed = yield* conversation.observe({
    _tag: "Restored",
    turn: turn.id,
    items: recorded,
    known,
  });
  if (!known)
    return yield* Effect.logInfo("Skipping restored Codex matching without saved receipt history", {
      sessionId,
      turnId: turn.id,
      observed: recorded.length,
      unread,
    });
  if (unread > 0)
    yield* Effect.logInfo("Checked restored Codex user-message receipts", {
      sessionId,
      turnId: turn.id,
      skipped: observed.repeated,
      read: observed.read.length,
      unread: unread - observed.read.length,
    });
});
