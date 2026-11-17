import type { AgentSessionEvent } from "@usine/core/agent/session";
import {
  type AnchorKey,
  Conversation,
  ConversationId,
  type EndedTurn,
  type EventSequence,
  MemberMessage,
  type MemberPost,
  Message,
  type QueuedTurn,
  type Reply,
  type RunningTurn,
  type SucceededTurn,
  SupervisorMessage,
  Turn,
  TurnEvent,
  TurnId,
} from "@usine/core/conversation";
import { type Brand, Context, type Effect, type Option, Schema } from "effect";

/** A conversation with its messages and turns, both in message order. */
export class ConversationRecord extends Schema.Class<
  ConversationRecord,
  Brand.Brand<"@usine/orchestrator/conversation/store/ConversationRecord">
>("@usine/orchestrator/ConversationRecord")({
  conversation: Conversation,
  messages: Schema.Array(Message),
  turns: Schema.Array(Turn),
}) {}

/** A member message and the turn that it queued. */
export class Posted extends Schema.Class<
  Posted,
  Brand.Brand<"@usine/orchestrator/conversation/store/Posted">
>("@usine/orchestrator/Posted")({
  message: MemberMessage,
  turn: Turn,
}) {}

/** The conversation store couldn't read or write. */
export class ConversationStoreError extends Schema.TaggedError<
  ConversationStoreError,
  Brand.Brand<"@usine/orchestrator/conversation/store/ConversationStoreError">
>("@usine/orchestrator/ConversationStoreError")("ConversationStoreError", {
  operation: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** No conversation has this ID. */
export class ConversationNotFound extends Schema.TaggedError<
  ConversationNotFound,
  Brand.Brand<"@usine/orchestrator/conversation/store/ConversationNotFound">
>("@usine/orchestrator/ConversationNotFound")("ConversationNotFound", {
  conversation: ConversationId,
}) {}

/** The stored turn is no longer in the state that a transition starts from. */
export class TurnConflict extends Schema.TaggedError<
  TurnConflict,
  Brand.Brand<"@usine/orchestrator/conversation/store/TurnConflict">
>("@usine/orchestrator/TurnConflict")("TurnConflict", {
  turn: TurnId,
  expected: Schema.NonEmptyString,
}) {}

/**
 * Stores conversations with the supervisor: their messages, their turns, and the session events
 * of each turn. The store numbers messages and events; every write is atomic.
 */
export class ConversationStore extends Context.Service<
  ConversationStore,
  {
    /** Stores `conversation` with the first member message of `post` and the turn it queues. */
    readonly create: (
      conversation: Conversation,
      post: MemberPost,
    ) => Effect.Effect<ConversationRecord, ConversationStoreError>;
    /** Appends the member message of `post` to its conversation and queues its turn. */
    readonly post: (
      post: MemberPost,
    ) => Effect.Effect<Posted, ConversationStoreError | ConversationNotFound>;
    readonly get: (
      id: ConversationId,
    ) => Effect.Effect<Option.Option<ConversationRecord>, ConversationStoreError>;
    /** The conversations with the anchor `key`, or all with `None`, newest first. */
    readonly list: (
      key: Option.Option<AnchorKey>,
    ) => Effect.Effect<ReadonlyArray<Conversation>, ConversationStoreError>;
    /** Replaces the stored `from` with `to`, which must have the same ID. */
    readonly transition: (
      from: QueuedTurn | RunningTurn,
      to: RunningTurn | EndedTurn,
    ) => Effect.Effect<void, ConversationStoreError | TurnConflict>;
    /** Replaces the stored `from` with the succeeded `to` and appends `reply` in one write. */
    readonly answer: (
      from: RunningTurn,
      to: SucceededTurn,
      reply: Reply,
    ) => Effect.Effect<SupervisorMessage, ConversationStoreError | TurnConflict>;
    /** Appends the session events of `turn`, numbered after the conversation's last event. */
    readonly append: (
      turn: Turn,
      events: ReadonlyArray<AgentSessionEvent>,
    ) => Effect.Effect<ReadonlyArray<TurnEvent>, ConversationStoreError>;
    /** At most `limit` events of `conversation` after `after`, in order. `0` reads from the start. */
    readonly events: (
      conversation: ConversationId,
      after: EventSequence | 0,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<TurnEvent>, ConversationStoreError>;
    /** The queued and running turns of every conversation, oldest first. */
    readonly open: Effect.Effect<ReadonlyArray<QueuedTurn | RunningTurn>, ConversationStoreError>;
  }
>()("@usine/orchestrator/conversation/store/ConversationStore") {}
