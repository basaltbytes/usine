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
import { Effect, Option, Schema } from "effect";
import { type ConversationSummary, lastActivity, type ReadMarker } from "./store.ts";

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

/** The most characters of a conversation's last message that the list shows. */
export const PREVIEW_LENGTH = 140;

export const ConversationSummaryView = Schema.Struct({
  conversation: Conversation,
  /** The latest turn in message order, or null before the first. */
  lastTurn: Schema.NullOr(TurnView),
  /** The sequence of the latest message. Marking the conversation read through it clears `unread`. */
  lastMessage: MessageSequence,
  /** When the latest message, turn start, or turn end happened. */
  lastActivity: Schema.DateTimeUtc,
  /** The latest message as one line of plain text, at most 140 characters. */
  preview: Schema.String,
  /**
   * Whether the calling member has unread activity: a message from someone else, or a failed
   * turn, after their read marker. Null for a credential without a member.
   */
  unread: Schema.NullOr(Schema.Boolean),
}).annotate({ title: "Conversation summary" });

export const ConversationsView = Schema.Struct({
  conversations: Schema.Array(ConversationSummaryView),
}).annotate({ title: "Conversations" });

const isText = Schema.is(Schema.String);

/**
 * Returns `body` as one line of plain text, at most `PREVIEW_LENGTH` characters, or an empty
 * string for a body that isn't text.
 */
const previewOf = (body: MessageBody): string => {
  const text = (isText(body) ? body : "")
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/[*_`#>~]+/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
};

/** Returns the list row of `summary`. */
export const summaryView = (summary: ConversationSummary): typeof ConversationSummaryView.Type => ({
  conversation: summary.conversation,
  lastTurn: Option.getOrNull(Option.map(summary.lastTurn, turnView)),
  lastMessage: Option.match(summary.lastMessage, {
    onNone: () => MessageSequence.make(1),
    onSome: ({ sequence }) => sequence,
  }),
  lastActivity: lastActivity(summary),
  preview: Option.match(summary.lastMessage, {
    onNone: () => "",
    onSome: ({ body }) => previewOf(body),
  }),
  unread: Option.getOrNull(summary.unread),
});

export const MarkReadPayload = Schema.Struct({
  /** The last message that the member has read. A later sequence marks the last message read. */
  through: MessageSequence,
}).annotate({ title: "Mark read" });

export const ReadMarkerView = Schema.Struct({
  conversation: ConversationId,
  /** The last message that the member has read. */
  through: MessageSequence,
  readAt: Schema.DateTimeUtc,
}).annotate({ title: "Read marker" });

/** Returns the API view of `marker`, without the member it belongs to. */
export const readMarkerView = (marker: ReadMarker): typeof ReadMarkerView.Type => ({
  conversation: marker.conversation,
  through: marker.through,
  readAt: marker.at,
});

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
