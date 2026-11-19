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
import {
  Answer,
  CallTarget,
  GrantRevocation,
  isGrantable,
  OperationName,
  PermissionRequestId,
  RequestState,
  StandingGrantId,
  WritePermission,
} from "@usine/core/permission-request";
import { ProjectId } from "@usine/core/project";
import { Effect, Option, Schema } from "effect";
import type { GrantEntry, RequestEntry } from "./permissions/permissions.ts";
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

/** A permission request as the API shows it, without the credentials of the members. */
export const PermissionRequestView = Schema.Struct({
  id: PermissionRequestId,
  conversation: ConversationId,
  turn: TurnId,
  /**
   * The harness's ID of the tool call: the `callId` of the turn's `ToolStarted` and `ToolFinished`
   * events of the call. Null when the harness gave none.
   */
  toolCall: Schema.NullOr(Schema.String),
  operation: OperationName,
  /** The operation's summary, such as `Retry a failed run`. */
  summary: Schema.String,
  /** The tool arguments: path and query parameters by name, and `body`. */
  arguments: Schema.Record(Schema.String, Schema.Json),
  target: CallTarget,
  /** The project of the target, or null for an operation outside a project. */
  project: Schema.NullOr(ProjectId),
  /** The permission that answering needs on the call's scope. */
  permission: WritePermission,
  /** Whether `always` is an answer: only a call in a project can have a standing grant. */
  grantable: Schema.Boolean,
  requestedAt: Schema.DateTimeUtc,
  state: RequestState,
  /** The turn that reported the outcome to the supervisor, or null. */
  reportedIn: Schema.NullOr(TurnId),
  /** Whether the caller can answer the request now. */
  answerable: Schema.Boolean,
}).annotate({ title: "Permission request" });

/** Returns the API view of `request`. */
export const requestView = ({
  request,
  answerable,
}: RequestEntry): typeof PermissionRequestView.Type => ({
  id: request.id,
  conversation: request.conversation,
  turn: request.turn,
  toolCall: Option.getOrNull(request.toolCall),
  operation: request.call.operation,
  summary: request.call.summary,
  arguments: request.call.arguments,
  target: request.call.target,
  project: request.call.scope._tag === "Project" ? request.call.scope.project : null,
  permission: request.call.permission,
  grantable: isGrantable(request.call),
  requestedAt: request.requestedAt,
  state: request.state,
  reportedIn: Option.getOrNull(request.reportedIn),
  answerable,
});

export const ConversationView = Schema.Struct({
  conversation: Conversation,
  messages: Schema.Array(Message),
  turns: Schema.Array(TurnView),
  /** The permission requests of the conversation's turns, oldest first. */
  requests: Schema.Array(PermissionRequestView),
}).annotate({ title: "Conversation with messages, turns, and permission requests" });

export const AnswerPayload = Schema.Struct({
  /** `once` runs the call, `always` also stores a standing grant, and `deny` runs nothing. */
  answer: Answer,
}).annotate({ title: "Answer" });

/** A standing grant as the API shows it, without the credential of its member. */
export const StandingGrantView = Schema.Struct({
  id: StandingGrantId,
  operation: OperationName,
  /** The operation's summary, such as `Retry a failed run`. */
  summary: Schema.String,
  project: ProjectId,
  /** The member who allowed it. */
  member: TurnMember,
  /** The request whose answer created it. */
  request: PermissionRequestId,
  createdAt: Schema.DateTimeUtc,
  /** When a call last ran under it, or null. */
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** Who revoked it and when, or null. */
  revoked: Schema.NullOr(GrantRevocation),
  /** Whether it applies now: it isn't revoked, and its member's access permits its operation. */
  applies: Schema.Boolean,
  /** Whether the caller can revoke it. */
  revocable: Schema.Boolean,
}).annotate({ title: "Standing grant" });

/** Returns the API view of `entry`. */
export const grantView = ({
  grant,
  applies,
  revocable,
}: GrantEntry): typeof StandingGrantView.Type => ({
  id: grant.id,
  operation: grant.operation,
  summary: grant.summary,
  project: grant.project,
  member: grant.member,
  request: grant.request,
  createdAt: grant.createdAt,
  lastUsedAt: Option.getOrNull(grant.lastUsedAt),
  revoked: Option.getOrNull(grant.revoked),
  applies,
  revocable,
});

export const StandingGrantsView = Schema.Struct({
  grants: Schema.Array(StandingGrantView),
}).annotate({ title: "Standing grants" });

/** The most allowed calls that one read returns. */
export const ACTIONS_PAGE = 100;

export const SupervisorActionsView = Schema.Struct({
  /** The calls that members allowed or standing grants covered, latest answer first. */
  actions: Schema.Array(PermissionRequestView),
}).annotate({ title: "Supervisor actions" });

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
