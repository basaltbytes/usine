import { type Brand, Crypto, DateTime, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { AccessScope, GitHubUserId, PermissionGrant, permits, TokenId } from "./access.ts";
import {
  type AgentSessionEvent,
  AgentSessionEvent as AgentSessionEventSchema,
  HarnessSession,
  SessionTokensUpdated,
} from "./agent/session.ts";
import { OperatorLogin } from "./operator.ts";

/** The ID of a conversation with the supervisor. */
export const ConversationId = Schema.NonEmptyString.pipe(Schema.brand("ConversationId"));
export type ConversationId = typeof ConversationId.Type;

/** The ID of one turn of a conversation. */
export const TurnId = Schema.NonEmptyString.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;

/** The 1-based position of a message in its conversation. */
export const MessageSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("MessageSequence"),
);
export type MessageSequence = typeof MessageSequence.Type;

/** The 1-based position of a turn event in its conversation, across turns. */
export const EventSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("EventSequence"),
);
export type EventSequence = typeof EventSequence.Type;

/** A conversation's title, at most 200 characters. */
export const ConversationTitle = Schema.NonEmptyString.check(Schema.isMaxLength(200)).pipe(
  Schema.brand("ConversationTitle"),
);
export type ConversationTitle = typeof ConversationTitle.Type;

/** What an anchor points at, such as a walkthrough passage. usine stores it without reading it. */
export const AnchorKind = Schema.NonEmptyString.check(Schema.isMaxLength(100)).pipe(
  Schema.brand("AnchorKind"),
);
export type AnchorKind = typeof AnchorKind.Type;

/** The anchored thing within its kind. usine stores it without reading it. */
export const AnchorReference = Schema.NonEmptyString.check(Schema.isMaxLength(2000)).pipe(
  Schema.brand("AnchorReference"),
);
export type AnchorReference = typeof AnchorReference.Type;

/** The lowercase hex SHA-256 of the JSON array `[kind, reference]`. */
export const AnchorKey = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u, { message: "Expected a lowercase hex SHA-256" }),
).pipe(Schema.brand("AnchorKey"));
export type AnchorKey = typeof AnchorKey.Type;

// Encoding a JSON value to text can't fail.
const jsonText = (value: Schema.Json) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(value).pipe(Effect.orDie);

/** What a conversation is about, such as a walkthrough passage, looked up by `key`. */
export class Anchor extends Schema.Class<Anchor, Brand.Brand<"@usine/core/conversation/Anchor">>(
  "Conversation/Anchor",
)({
  kind: AnchorKind,
  reference: AnchorReference,
  key: AnchorKey,
}) {}

/** Returns the anchor of `reference` in `kind`, with its key. */
export const anchorOf = Effect.fn("Conversation.anchorOf")(function* (
  kind: AnchorKind,
  reference: AnchorReference,
) {
  const crypto = yield* Crypto.Crypto;
  const text = yield* jsonText([kind, reference]);
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.orDie);
  return Anchor.make({ kind, reference, key: AnchorKey.make(Hex.encode(digest)) });
});

/** How a message body is written, such as `markdown`. usine stores it without reading it. */
export const MessageFormat = Schema.NonEmptyString.check(Schema.isMaxLength(100)).pipe(
  Schema.brand("MessageFormat"),
);
export type MessageFormat = typeof MessageFormat.Type;

/** The format of a member message or reply that names none. */
export const defaultFormat = MessageFormat.make("markdown");

/** A message's content: any JSON value except an empty string. */
export const MessageBody = Schema.Json.check(
  Schema.makeFilter((body) => body !== "", { message: "Expected a non-empty message body" }),
).pipe(Schema.brand("MessageBody"));
export type MessageBody = typeof MessageBody.Type;

const isText = Schema.is(Schema.String);

/** The text of `body` for the model: a string as it is, any other value as JSON. */
export const bodyText = (body: MessageBody): Effect.Effect<string> =>
  isText(body) ? Effect.succeed(body) : jsonText(body);

/** A conversation with the supervisor, readable by every member who can read its scope. */
export class Conversation extends Schema.Class<
  Conversation,
  Brand.Brand<"@usine/core/conversation/Conversation">
>("Conversation/Conversation")({
  id: ConversationId,
  title: ConversationTitle,
  /** The instance, or the project whose members read the conversation and whose context it uses. */
  scope: AccessScope,
  anchor: Schema.OptionFromNullOr(Anchor),
  createdBy: OperatorLogin,
  createdAt: Schema.DateTimeUtc,
}) {}

/** The member who posted a message, and whose access the turn that answers it runs with. */
export class TurnMember extends Schema.Class<
  TurnMember,
  Brand.Brand<"@usine/core/conversation/TurnMember">
>("Conversation/TurnMember")({
  id: GitHubUserId,
  login: OperatorLogin,
}) {}

/** A message posted with a device token, which the turn's access depends on. */
export class PostedWithToken extends Schema.TaggedClass<
  PostedWithToken,
  Brand.Brand<"@usine/core/conversation/PostedWithToken">
>("PostingCredential/PostedWithToken")("PostedWithToken", {
  /** The token's ID; the token's secret is never stored. */
  tokenId: TokenId,
}) {}

/** A message posted from a browser session, which ends without affecting the turn. */
export class PostedWithSession extends Schema.TaggedClass<
  PostedWithSession,
  Brand.Brand<"@usine/core/conversation/PostedWithSession">
>("PostingCredential/PostedWithSession")("PostedWithSession", {}) {}

/**
 * What identifies the credential that posted a message. A turn's access is recomputed from it,
 * and from the member's current grants, each time the turn uses it, so a revoked token ends that
 * access. It stays on the server: API views of a turn leave it out.
 */
export const PostingCredential = Schema.Union([PostedWithToken, PostedWithSession]);
export type PostingCredential = typeof PostingCredential.Type;

/**
 * Returns the grants of a turn in `scope` for a posting credential with `grants`: `read` on the
 * scope if `grants` permit it, and nothing else. A turn is read-only, and reads nothing that the
 * conversation's readers can't read.
 */
export const turnGrants = (
  scope: AccessScope,
  grants: ReadonlyArray<PermissionGrant>,
): ReadonlyArray<PermissionGrant> =>
  permits(grants, "read", scope) ? [PermissionGrant.make({ permission: "read", scope })] : [];

const messageFields = {
  conversation: ConversationId,
  sequence: MessageSequence,
  /** The turn that the message queued, or that answered it. */
  turn: TurnId,
  format: MessageFormat,
  body: MessageBody,
  createdAt: Schema.DateTimeUtc,
};

/** A message that a member posted. */
export class MemberMessage extends Schema.Class<
  MemberMessage,
  Brand.Brand<"@usine/core/conversation/MemberMessage">
>("Conversation/MemberMessage")({
  ...messageFields,
  role: Schema.Literal("member"),
  author: OperatorLogin,
}) {}

/** The supervisor's answer to a member message. */
export class SupervisorMessage extends Schema.Class<
  SupervisorMessage,
  Brand.Brand<"@usine/core/conversation/SupervisorMessage">
>("Conversation/SupervisorMessage")({
  ...messageFields,
  role: Schema.Literal("supervisor"),
}) {}

export const Message = Schema.Union([MemberMessage, SupervisorMessage]);
export type Message = typeof Message.Type;

/** A turn that waits for the conversation's earlier turns to end. */
export class Queued extends Schema.TaggedClass<
  Queued,
  Brand.Brand<"@usine/core/conversation/Queued">
>("TurnState/Queued")("Queued", {}) {}

/** A turn whose supervisor session is running. */
export class Running extends Schema.TaggedClass<
  Running,
  Brand.Brand<"@usine/core/conversation/Running">
>("TurnState/Running")("Running", {
  startedAt: Schema.DateTimeUtc,
}) {}

/**
 * The session's cumulative usage across the conversation's turns when the turn ended, or `None`
 * when no turn reported usage.
 */
const usage = Schema.OptionFromNullOr(SessionTokensUpdated);

/** A turn whose supervisor answered. */
export class Succeeded extends Schema.TaggedClass<
  Succeeded,
  Brand.Brand<"@usine/core/conversation/Succeeded">
>("TurnState/Succeeded")("Succeeded", {
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  /** The saved session that the conversation's next turn reopens. */
  session: HarnessSession,
  usage,
}) {}

/** The orchestrator stopped while the turn ran. */
export class Interrupted extends Schema.TaggedClass<
  Interrupted,
  Brand.Brand<"@usine/core/conversation/Interrupted">
>("TurnFailure/Interrupted")("Interrupted", {}) {}

/** The supervisor couldn't run the turn or returned no answer. */
export class TurnError extends Schema.TaggedClass<
  TurnError,
  Brand.Brand<"@usine/core/conversation/TurnError">
>("TurnFailure/TurnError")("TurnError", {
  message: Schema.NonEmptyString,
}) {}

export const TurnFailure = Schema.Union([Interrupted, TurnError]);
export type TurnFailure = typeof TurnFailure.Type;

/** A turn that ended without an answer. The events it produced stay. */
export class Failed extends Schema.TaggedClass<
  Failed,
  Brand.Brand<"@usine/core/conversation/Failed">
>("TurnState/Failed")("Failed", {
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  failure: TurnFailure,
  usage,
}) {}

/** A turn that a member canceled. The events it produced stay. */
export class Canceled extends Schema.TaggedClass<
  Canceled,
  Brand.Brand<"@usine/core/conversation/Canceled">
>("TurnState/Canceled")("Canceled", {
  /** When the turn started, or `None` for a turn canceled while queued. */
  startedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  endedAt: Schema.DateTimeUtc,
  by: OperatorLogin,
  usage,
}) {}

/**
 * The turn state machine:
 *
 *   queued ──► running ──► succeeded | failed | canceled
 *   queued ──► canceled
 *
 * Each transition accepts only a turn in its legal source state.
 */
export const TurnState = Schema.Union([Queued, Running, Succeeded, Failed, Canceled]);
export type TurnState = typeof TurnState.Type;

/** One run of the supervisor that answers one member message. */
export class Turn extends Schema.Class<Turn, Brand.Brand<"@usine/core/conversation/Turn">>(
  "Conversation/Turn",
)({
  id: TurnId,
  conversation: ConversationId,
  member: TurnMember,
  credential: PostingCredential,
  /** The member message that the turn answers. */
  message: MessageSequence,
  /** The format that the member asked the answer to use. */
  reply: MessageFormat,
  queuedAt: Schema.DateTimeUtc,
  state: TurnState,
}) {}

export type QueuedTurn = Turn & { readonly state: Queued };
export type RunningTurn = Turn & { readonly state: Running };
export type SucceededTurn = Turn & { readonly state: Succeeded };
export type EndedTurn = Turn & { readonly state: Succeeded | Failed | Canceled };

export const isQueued = (turn: Turn): turn is QueuedTurn => turn.state._tag === "Queued";
export const isRunning = (turn: Turn): turn is RunningTurn => turn.state._tag === "Running";
export const isOpen = (turn: Turn): turn is QueuedTurn | RunningTurn =>
  isQueued(turn) || isRunning(turn);

type TurnFields = Omit<Parameters<typeof Turn.make>[0], "state">;

// SAFETY: `Turn.make` checks `state` against `TurnState` and keeps the `state` passed in.
const withState = <S extends TurnState>(turn: TurnFields, state: S) =>
  Turn.make({ ...turn, state }) as Turn & { readonly state: S };

export const startTurn = (turn: QueuedTurn, at: DateTime.Utc): RunningTurn =>
  withState(turn, Running.make({ startedAt: at }));

export const succeedTurn = (
  turn: RunningTurn,
  at: DateTime.Utc,
  session: HarnessSession,
  spent: Option.Option<SessionTokensUpdated>,
): SucceededTurn =>
  withState(
    turn,
    Succeeded.make({ startedAt: turn.state.startedAt, endedAt: at, session, usage: spent }),
  );

export const failTurn = (
  turn: RunningTurn,
  at: DateTime.Utc,
  failure: TurnFailure,
  spent: Option.Option<SessionTokensUpdated>,
) =>
  withState(
    turn,
    Failed.make({ startedAt: turn.state.startedAt, endedAt: at, failure, usage: spent }),
  );

export const cancelTurn = (
  turn: QueuedTurn | RunningTurn,
  at: DateTime.Utc,
  by: OperatorLogin,
  spent: Option.Option<SessionTokensUpdated>,
) =>
  withState(
    turn,
    Canceled.make({
      startedAt: isRunning(turn) ? Option.some(turn.state.startedAt) : Option.none(),
      endedAt: at,
      by,
      usage: spent,
    }),
  );

/** What a member posts: one message, and the turn that answers it. */
export class MemberPost extends Schema.Class<
  MemberPost,
  Brand.Brand<"@usine/core/conversation/MemberPost">
>("Conversation/MemberPost")({
  conversation: ConversationId,
  turn: TurnId,
  member: TurnMember,
  credential: PostingCredential,
  format: MessageFormat,
  body: MessageBody,
  reply: MessageFormat,
  at: Schema.DateTimeUtc,
}) {}

/** Returns the message of `post` at `sequence`, and its queued turn. */
export const posted = (post: MemberPost, sequence: MessageSequence) => ({
  message: MemberMessage.make({
    conversation: post.conversation,
    sequence,
    turn: post.turn,
    format: post.format,
    body: post.body,
    createdAt: post.at,
    role: "member",
    author: post.member.login,
  }),
  turn: withState(
    {
      id: post.turn,
      conversation: post.conversation,
      member: post.member,
      credential: post.credential,
      message: sequence,
      reply: post.reply,
      queuedAt: post.at,
    },
    Queued.make({}),
  ),
});

/** The supervisor's answer to a turn, before the store gives it a sequence. */
export class Reply extends Schema.Class<Reply, Brand.Brand<"@usine/core/conversation/Reply">>(
  "Conversation/Reply",
)({
  body: MessageBody,
  at: Schema.DateTimeUtc,
}) {}

/** Returns the supervisor message of `reply` to `turn` at `sequence`. */
export const replied = (turn: Turn, reply: Reply, sequence: MessageSequence) =>
  SupervisorMessage.make({
    conversation: turn.conversation,
    sequence,
    turn: turn.id,
    format: turn.reply,
    body: reply.body,
    createdAt: reply.at,
    role: "supervisor",
  });

/** One session event of a turn, at its position in the conversation. */
export class TurnEvent extends Schema.Class<
  TurnEvent,
  Brand.Brand<"@usine/core/conversation/TurnEvent">
>("Conversation/TurnEvent")({
  conversation: ConversationId,
  sequence: EventSequence,
  turn: TurnId,
  event: AgentSessionEventSchema,
}) {}

/** Returns the events of `turn` from `first` on, numbered in order. */
export const numbered = (
  turn: Turn,
  events: ReadonlyArray<AgentSessionEvent>,
  first: EventSequence,
): ReadonlyArray<TurnEvent> =>
  events.map((event, index) =>
    TurnEvent.make({
      conversation: turn.conversation,
      sequence: EventSequence.make(first + index),
      turn: turn.id,
      event,
    }),
  );

/** Where a conversation's next turn continues: the session to reopen and the usage so far. */
export interface ResumePoint {
  readonly session: Option.Option<HarnessSession>;
  readonly usage: Option.Option<SessionTokensUpdated>;
}

/**
 * Returns where the next turn after `turns`, in message order, continues: the session that the
 * last succeeded turn saved, and the usage of the last ended turn that reported one.
 */
export const resumePoint = (turns: ReadonlyArray<Turn>): ResumePoint => {
  let session = Option.none<HarnessSession>();
  let spent = Option.none<SessionTokensUpdated>();
  for (const { state } of turns) {
    if (state._tag === "Succeeded") session = Option.some(state.session);
    if (state._tag === "Succeeded" || state._tag === "Failed" || state._tag === "Canceled")
      spent = Option.orElse(state.usage, () => spent);
  }
  return { session, usage: spent };
};
