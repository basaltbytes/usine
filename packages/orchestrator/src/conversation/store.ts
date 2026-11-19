import { GitHubUserId } from "@usine/core/access";
import type { AgentSessionEvent } from "@usine/core/agent/session";
import {
  type AnchorKey,
  Conversation,
  ConversationId,
  type EndedTurn,
  type EventSequence,
  type FollowUpPost,
  MemberMessage,
  type MemberPost,
  Message,
  MessageSequence,
  type QueuedTurn,
  type Reply,
  type RunningTurn,
  type SucceededTurn,
  SupervisorMessage,
  Turn,
  TurnEvent,
  TurnId,
} from "@usine/core/conversation";
import { type Brand, Context, DateTime, type Effect, Option, Schema } from "effect";

/** A conversation with its messages and turns, both in message order. */
export class ConversationRecord extends Schema.Class<
  ConversationRecord,
  Brand.Brand<"@usine/orchestrator/conversation/store/ConversationRecord">
>("@usine/orchestrator/ConversationRecord")({
  conversation: Conversation,
  messages: Schema.Array(Message),
  turns: Schema.Array(Turn),
}) {}

/** How far a member has read a conversation: through a message, as of a time. */
export class ReadMarker extends Schema.Class<
  ReadMarker,
  Brand.Brand<"@usine/orchestrator/conversation/store/ReadMarker">
>("@usine/orchestrator/ReadMarker")({
  conversation: ConversationId,
  member: GitHubUserId,
  through: MessageSequence,
  at: Schema.DateTimeUtc,
}) {}

/** A conversation with its latest turn and latest message, in message order. */
export class ConversationSummary extends Schema.Class<
  ConversationSummary,
  Brand.Brand<"@usine/orchestrator/conversation/store/ConversationSummary">
>("@usine/orchestrator/ConversationSummary")({
  conversation: Conversation,
  lastTurn: Schema.Option(Turn),
  lastMessage: Schema.Option(Message),
  /** Whether the conversation is unread for the reader that the list was for, if any. */
  unread: Schema.Option(Schema.Boolean),
}) {}

/** The time of the latest message, turn start, or turn end of `summary`'s conversation. */
export const lastActivity = ({ conversation, lastTurn, lastMessage }: ConversationSummary) => {
  const times = [
    conversation.createdAt,
    ...Option.toArray(Option.map(lastMessage, ({ createdAt }) => createdAt)),
    ...Option.toArray(
      Option.map(lastTurn, ({ queuedAt, state }) => {
        switch (state._tag) {
          case "Queued":
            return queuedAt;
          case "Running":
            return state.startedAt;
          default:
            return state.endedAt;
        }
      }),
    ),
  ];
  return times.reduce((latest, time) => DateTime.max(latest, time));
};

/**
 * Returns whether `member` has unread activity in a conversation with `messages` and `turns`: a
 * member or supervisor message after `marker` that someone else posted, or a turn that failed
 * after `marker`. Without a marker, every such message by someone else and every failed turn
 * counts. The outcomes messages that usine posts don't count.
 */
export const isUnread = (
  member: GitHubUserId,
  messages: ReadonlyArray<Message>,
  turns: ReadonlyArray<Turn>,
  marker: Option.Option<ReadMarker>,
): boolean => {
  const through = Option.match(marker, { onNone: () => 0, onSome: ({ through }) => through });
  const own = new Set(turns.filter((turn) => turn.member.id === member).map(({ id }) => id));
  const fromOthers = messages.some(
    (message) =>
      message.sequence > through &&
      message.role !== "usine" &&
      !(message.role === "member" && own.has(message.turn)),
  );
  const failed = turns.some(
    ({ state }) =>
      state._tag === "Failed" &&
      Option.match(marker, {
        onNone: () => true,
        onSome: ({ at }) => DateTime.isGreaterThan(state.endedAt, at),
      }),
  );
  return fromOthers || failed;
};

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
    /**
     * Appends the outcomes message of `post` and queues the turn that reports them, unless that
     * turn exists. Returns the queued turn, or `None` when it existed.
     */
    readonly followUp: (
      post: FollowUpPost,
    ) => Effect.Effect<Option.Option<Turn>, ConversationStoreError | ConversationNotFound>;
    /** Appends the member message of `post` to its conversation and queues its turn. */
    readonly post: (
      post: MemberPost,
    ) => Effect.Effect<Posted, ConversationStoreError | ConversationNotFound>;
    readonly get: (
      id: ConversationId,
    ) => Effect.Effect<Option.Option<ConversationRecord>, ConversationStoreError>;
    /**
     * The conversations with the anchor `key`, or all with `None`, newest first. With a `reader`,
     * each summary says whether the conversation is unread for that member.
     */
    readonly list: (
      key: Option.Option<AnchorKey>,
      reader: Option.Option<GitHubUserId>,
    ) => Effect.Effect<ReadonlyArray<ConversationSummary>, ConversationStoreError>;
    /**
     * Stores `marker` unless the member's stored marker is further along, and returns the stored
     * marker. A marker never moves back.
     */
    readonly markRead: (
      marker: ReadMarker,
    ) => Effect.Effect<ReadMarker, ConversationStoreError | ConversationNotFound>;
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
