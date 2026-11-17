import type { AccessDenied } from "@usine/core/access";
import {
  PostedWithSession,
  PostedWithToken,
  type PostingCredential,
  TurnMember,
} from "@usine/core/conversation";
import {
  type ConversationRequest,
  Conversations,
  type SupervisorNotReady,
  type TurnNotFound,
  type UnknownProject,
} from "@usine/orchestrator/conversation";
import type {
  ConversationNotFound,
  ConversationStoreError,
  TurnConflict,
} from "@usine/orchestrator/conversation/store";
import type { ConversationRecord } from "@usine/orchestrator/conversation/store";
import {
  EVENTS_PAGE,
  OperatorApi,
  OperatorHttpError,
  turnView,
} from "@usine/orchestrator/operator/http";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { RequestMember, RequestToken } from "../auth/http.ts";

const failure = (
  error:
    | AccessDenied
    | SupervisorNotReady
    | ConversationNotFound
    | TurnNotFound
    | UnknownProject
    | TurnConflict
    | ConversationStoreError,
) => {
  switch (error._tag) {
    case "AccessDenied":
      return OperatorHttpError.make({
        error: "AccessDenied",
        message: "You do not have permission for this operation.",
      });
    case "SupervisorNotReady":
      return OperatorHttpError.make({ error: "SupervisorNotReady", message: error.message });
    case "ConversationNotFound":
      return OperatorHttpError.make({
        error: "ConversationNotFound",
        message: `Conversation ${error.conversation} was not found.`,
      });
    case "TurnNotFound":
      return OperatorHttpError.make({
        error: "TurnNotFound",
        message: `Turn ${error.turn} was not found in this conversation.`,
      });
    case "UnknownProject":
      return OperatorHttpError.make({ error: "UnknownProject", message: error.message });
    case "TurnConflict":
      return OperatorHttpError.make({
        error: "TurnConflict",
        message: `Turn ${error.turn} changed while it was being canceled. Read the conversation again.`,
      });
    case "ConversationStoreError":
      return OperatorHttpError.make({
        error: "ConversationStoreError",
        message: `Conversation store error: could not ${error.operation}.`,
      });
  }
};

/** The API view of `record`, without the credentials that posted its messages. */
const conversationView = ({ conversation, messages, turns }: ConversationRecord) => ({
  conversation,
  messages,
  turns: turns.map(turnView),
});

const unavailable = "Conversations are unavailable until GitHub App setup is complete.";

/** The conversations of this server, or a refusal while it runs without them. */
const conversations = Effect.flatMap(Effect.serviceOption(Conversations), (service) =>
  Effect.fromOption(service).pipe(
    Effect.mapError(() =>
      OperatorHttpError.make({
        error: "SupervisorNotReady",
        message: unavailable,
      }),
    ),
  ),
);

/**
 * The member who sends the request, with the device token or browser session they send it with;
 * another credential can't post to the supervisor.
 */
const poster = Effect.flatMap(RequestMember, (current) =>
  Option.match(current, {
    onNone: () =>
      Effect.logWarning("Conversation write refused for a credential without a member").pipe(
        Effect.andThen(
          Effect.fail(
            OperatorHttpError.make({
              error: "AccessDenied",
              message: "Sign in as a member to talk to the supervisor.",
            }),
          ),
        ),
      ),
    onSome: ({ id, login }) =>
      Effect.map(RequestToken, (token) => ({
        member: TurnMember.make({ id, login }),
        credential: Option.match(
          Option.filter(token, ({ kind }) => kind === "device"),
          {
            onNone: (): PostingCredential => PostedWithSession.make({}),
            onSome: ({ id: tokenId }) => PostedWithToken.make({ tokenId }),
          },
        ),
      })),
  }),
);

/** The handlers of the operator API's `conversation` group. */
export const conversationHandlers = HttpApiBuilder.group(OperatorApi, "conversation", (routes) =>
  routes
    .handle("conversationStatus", () =>
      Effect.gen(function* () {
        const service = yield* Effect.serviceOption(Conversations);
        if (Option.isNone(service))
          return { state: "setup-required" as const, reason: unavailable };
        const status = yield* service.value.status;
        return status._tag === "SupervisorReady"
          ? { state: "ready" as const, reason: null }
          : { state: "setup-required" as const, reason: status.reason };
      }),
    )
    .handle("conversations", ({ query }) =>
      Effect.gen(function* () {
        const service = yield* conversations;
        const listed = yield* service
          .list(Option.fromUndefinedOr(query.anchor))
          .pipe(Effect.mapError(failure));
        return {
          conversations: listed.map(({ conversation, lastTurn }) => ({
            conversation,
            lastTurn: Option.getOrNull(Option.map(lastTurn, turnView)),
          })),
        };
      }),
    )
    .handle("startConversation", ({ payload }) =>
      Effect.gen(function* () {
        const service = yield* conversations;
        const caller = yield* poster;
        const request: ConversationRequest = {
          scope: payload.scope,
          anchor: Option.fromUndefinedOr(payload.anchor),
          title: Option.fromUndefinedOr(payload.title),
          message: {
            body: payload.message.body,
            format: payload.message.format,
            reply: payload.message.reply.format,
          },
        };
        const record = yield* service.start(request, caller).pipe(Effect.mapError(failure));
        return conversationView(record);
      }),
    )
    .handle("conversation", ({ params }) =>
      Effect.gen(function* () {
        const service = yield* conversations;
        const record = yield* service.read(params.conversation).pipe(Effect.mapError(failure));
        return conversationView(record);
      }),
    )
    .handle("conversationEvents", ({ params, query }) =>
      Effect.gen(function* () {
        const service = yield* conversations;
        const after = query.after ?? 0;
        const events = yield* service
          .events(params.conversation, after, EVENTS_PAGE)
          .pipe(Effect.mapError(failure));
        return { events, next: events.at(-1)?.sequence ?? after };
      }),
    )
    .handle("postMessage", ({ params, payload }) =>
      Effect.gen(function* () {
        const service = yield* conversations;
        const caller = yield* poster;
        const posted = yield* service
          .post(
            params.conversation,
            { body: payload.body, format: payload.format, reply: payload.reply.format },
            caller,
          )
          .pipe(Effect.mapError(failure));
        return { message: posted.message, turn: turnView(posted.turn) };
      }),
    )
    .handle("cancelTurn", ({ params }) =>
      Effect.gen(function* () {
        const service = yield* conversations;
        const caller = yield* poster;
        const turn = yield* service
          .cancel(params.conversation, params.turn, caller.member.login)
          .pipe(Effect.mapError(failure));
        return turnView(turn);
      }),
    ),
);
