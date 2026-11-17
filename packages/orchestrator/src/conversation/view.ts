import { AccessScope } from "@usine/core/access";
import {
  AnchorKind,
  AnchorReference,
  Conversation,
  ConversationId,
  ConversationTitle,
  defaultFormat,
  EventSequence,
  MemberMessage,
  Message,
  MessageBody,
  MessageFormat,
  MessageSequence,
  type Turn,
  TurnEvent,
  TurnId,
  TurnMember,
  TurnState,
} from "@usine/core/conversation";
import { Effect, Schema } from "effect";

/** Whether members can post to the supervisor, and why not. */
export const ConversationStatusView = Schema.Struct({
  state: Schema.Literals(["ready", "setup-required"]),
  /** What to set up before the supervisor takes messages, or null when it is ready. */
  reason: Schema.NullOr(Schema.String),
}).annotate({ title: "Supervisor status" });

/** A member message. `format` and `reply.format` default to `markdown`. */
export const MessagePayload = Schema.Struct({
  body: MessageBody,
  format: MessageFormat.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultFormat))),
  /** The format that the member asks the answer to use; the caller validates the answer. */
  reply: Schema.Struct({ format: MessageFormat }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ format: defaultFormat })),
  ),
}).annotate({ title: "Message" });

export const StartConversationPayload = Schema.Struct({
  scope: AccessScope,
  /** What the conversation is about; usine stores `kind` and `reference` without reading them. */
  anchor: Schema.optionalKey(Schema.Struct({ kind: AnchorKind, reference: AnchorReference })),
  /** Defaults to the first line of the message. */
  title: Schema.optionalKey(ConversationTitle),
  message: MessagePayload,
}).annotate({ title: "New conversation" });

/** A turn as the API shows it: who posted the message, but nothing about their credential. */
export const TurnView = Schema.Struct({
  id: TurnId,
  conversation: ConversationId,
  member: TurnMember,
  message: MessageSequence,
  reply: MessageFormat,
  queuedAt: Schema.DateTimeUtc,
  state: TurnState,
}).annotate({ title: "Turn" });

/** Returns the API view of `turn`. */
export const turnView = (turn: Turn): typeof TurnView.Type => ({
  id: turn.id,
  conversation: turn.conversation,
  member: turn.member,
  message: turn.message,
  reply: turn.reply,
  queuedAt: turn.queuedAt,
  state: turn.state,
});

export const ConversationsView = Schema.Struct({
  conversations: Schema.Array(
    Schema.Struct({
      conversation: Conversation,
      /** The latest turn in message order, or null before the first. */
      lastTurn: Schema.NullOr(TurnView),
    }),
  ),
}).annotate({ title: "Conversations" });

export const ConversationView = Schema.Struct({
  conversation: Conversation,
  messages: Schema.Array(Message),
  turns: Schema.Array(TurnView),
}).annotate({ title: "Conversation with messages and turns" });

export const PostedView = Schema.Struct({
  message: MemberMessage,
  turn: TurnView,
}).annotate({ title: "Posted message" });

/** The most events that one read returns. */
export const EVENTS_PAGE = 200;

export const ConversationEventsView = Schema.Struct({
  events: Schema.Array(TurnEvent),
  /** The cursor for the next read: the last returned sequence, or the requested one. */
  next: Schema.Union([EventSequence, Schema.Literal(0)]),
}).annotate({ title: "Turn events" });
