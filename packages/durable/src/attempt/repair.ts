import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type ConversationDocToken,
  type ConversationId,
  type Harness,
  InboxDoc,
  type JsonObject,
  LiveDoc,
  ProviderDoc,
  type TaskRecord,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { AttemptId } from "@usine/core/attempt";
import { Effect, Option, Result } from "effect";
import { durableError } from "../harness.ts";
import { AttemptRecordDoc } from "./documents.ts";
import { attemptIdOf } from "./request.ts";
import { ATTEMPT_TASK } from "./task.ts";

const call = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => durableError(operation, cause) });

/** One of the pi-durable documents a conversation's generations and tools read: how to read it and how to start it over. */
interface ConversationDocument {
  readonly kind: string;
  /** Rejects when the stored document does not read back. */
  readonly read: (harness: Harness, conversationId: ConversationId) => Promise<void>;
  /** Retires the stored document without reading it and creates it again with its initial value. */
  readonly replace: (tx: Tx, conversationId: ConversationId) => Promise<void>;
}

const conversationDocument = <T extends JsonObject>(
  token: ConversationDocToken<T>,
): ConversationDocument => ({
  kind: token.definition.kind,
  read: async (harness, conversationId) => {
    await harness.snapshot(token, conversationId, BACKGROUND_CONTEXT);
  },
  replace: async (tx, conversationId) => {
    await tx.retireDoc(token, conversationId);
    await tx.doc(token, conversationId);
  },
});

const CONVERSATION_DOCUMENTS: ReadonlyArray<ConversationDocument> = [
  conversationDocument(LiveDoc),
  conversationDocument(InboxDoc),
  conversationDocument(UsageDoc),
  conversationDocument(AgentDoc),
  conversationDocument(ProviderDoc),
];

const messageOf = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);

type LiveTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** The conversation's documents that no longer read back, with the reason each one fails. */
const unreadableDocuments = Effect.fn("AttemptRepair.unreadableDocuments")(function* (
  harness: Harness,
  conversationId: ConversationId,
) {
  const unreadable: Array<{ readonly document: ConversationDocument; readonly message: string }> =
    [];
  for (const document of CONVERSATION_DOCUMENTS) {
    const read = yield* Effect.tryPromise({
      try: () => document.read(harness, conversationId),
      catch: messageOf,
    }).pipe(Effect.result);
    if (Result.isFailure(read)) unreadable.push({ document, message: read.failure });
  }
  return unreadable;
});

/** The Attempt whose `usine.attempt` task owns the conversation, if one does. */
const owningAttempt = Effect.fn("AttemptRepair.owningAttempt")(function* (
  harness: Harness,
  conversationId: ConversationId,
) {
  const conversation = yield* call("read the conversation", () =>
    harness.commit((tx) => tx.conversation(conversationId), BACKGROUND_CONTEXT),
  );
  const ownerTaskId = conversation?.owner?.taskId;
  if (ownerTaskId === undefined) return Option.none<AttemptId>();
  const owner = yield* call("read the conversation's owner task", () =>
    harness.getTask(ownerTaskId, BACKGROUND_CONTEXT),
  );
  if (owner === undefined || owner.kind !== ATTEMPT_TASK) return Option.none<AttemptId>();
  return attemptIdOf(owner.input);
});

/**
 * Replaces the unreadable documents of the live tasks' conversations in one
 * commit, and records the reason on the Attempt that owns each conversation.
 */
const replaceUnreadable = Effect.fn("AttemptRepair.replaceUnreadable")(function* (
  harness: Harness,
  tasks: ReadonlyArray<LiveTask>,
) {
  const conversations = [...new Set(tasks.map(({ conversationId }) => conversationId))];
  const repairs: Array<{
    readonly conversationId: ConversationId;
    readonly documents: ReadonlyArray<ConversationDocument>;
    readonly attempt: Option.Option<AttemptId>;
    readonly cause: string;
  }> = [];
  for (const conversationId of conversations) {
    const unreadable = yield* unreadableDocuments(harness, conversationId);
    if (unreadable.length === 0) continue;
    const reasons = unreadable.map(({ document, message }) => `${document.kind}: ${message}`);
    repairs.push({
      conversationId,
      documents: unreadable.map(({ document }) => document),
      attempt: yield* owningAttempt(harness, conversationId),
      cause: `The parent conversation ${conversationId} could not be read back from durable storage (${reasons.join("; ")})`,
    });
  }
  if (repairs.length === 0) {
    yield* Effect.logDebug("Every live task's conversation reads back", {
      conversations: conversations.length,
    });
    return;
  }
  yield* call("replace the unreadable documents", () =>
    harness.commit(async (tx) => {
      for (const repair of repairs) {
        for (const document of repair.documents) await document.replace(tx, repair.conversationId);
        if (Option.isSome(repair.attempt)) {
          const record = await tx.doc(AttemptRecordDoc, repair.attempt.value, null);
          record.storageFailure = repair.cause;
        }
      }
    }, BACKGROUND_CONTEXT),
  );
  for (const repair of repairs) {
    yield* Option.match(repair.attempt, {
      onNone: () =>
        Effect.logWarning("Replaced unreadable documents of a conversation no Attempt owns", {
          conversationId: repair.conversationId,
          cause: repair.cause,
        }),
      onSome: (attemptId) =>
        Effect.logError(
          "Replaced the unreadable documents of an Attempt's parent conversation; the Attempt fails",
          { attemptId, conversationId: repair.conversationId, cause: repair.cause },
        ),
    });
  }
});

/** Aborts each live `usine.attempt` task whose Attempt record names a storage failure. */
const abortFailedAttempts = Effect.fn("AttemptRepair.abortFailedAttempts")(function* (
  harness: Harness,
  tasks: ReadonlyArray<LiveTask>,
) {
  for (const task of tasks) {
    if (task.kind !== ATTEMPT_TASK || task.abortRequested) continue;
    const attemptId = attemptIdOf(task.input);
    if (Option.isNone(attemptId)) continue;
    const record = yield* call("read the Attempt record", () =>
      harness.snapshot(AttemptRecordDoc, attemptId.value, BACKGROUND_CONTEXT),
    );
    if (record?.storageFailure === undefined) continue;
    yield* call("abort the Attempt task", () => harness.abortTask(task.id, BACKGROUND_CONTEXT));
    yield* Effect.logInfo("Aborting the Attempt task whose conversation could not be read", {
      attemptId: attemptId.value,
      taskId: task.id,
    });
  }
});

/**
 * Runs before the harness resumes its tasks. A document pi-durable cannot read
 * back stops every step that needs it, so instead of letting that stop the
 * whole harness, this replaces the unreadable documents of each live task's
 * conversation and fails only the Attempt that owns the conversation: its
 * record keeps the reason and its task is aborted, which records the failure.
 */
export const repairUnreadableConversations = (harness: Harness): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { tasks } = yield* call("inspect the live tasks", () =>
      harness.inspect(BACKGROUND_CONTEXT),
    );
    const records = tasks.map(({ record }) => record);
    yield* replaceUnreadable(harness, records);
    yield* abortFailedAttempts(harness, records);
  }).pipe(
    Effect.tapError((error) =>
      Effect.logError("Could not repair the durable storage before resuming its tasks", {
        operation: error.operation,
        message: error.message,
      }),
    ),
    Effect.ignore,
    Effect.withSpan("AttemptRepair.repair"),
  );
