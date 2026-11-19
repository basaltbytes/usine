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
import {
  type GrantNotFound,
  type NotGrantable,
  type PermissionRequestNotFound,
  Permissions,
  type RequestAnswered,
} from "@usine/orchestrator/conversation/permissions";
import type { PermissionStoreError } from "@usine/orchestrator/conversation/permissions/store";
import type {
  ConversationNotFound,
  ConversationStoreError,
  TurnConflict,
} from "@usine/orchestrator/conversation/store";
import type { ConversationRecord } from "@usine/orchestrator/conversation/store";
import {
  ACTIONS_PAGE,
  EVENTS_PAGE,
  grantView,
  OperatorApi,
  OperatorHttpError,
  readMarkerView,
  requestView,
  summaryView,
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
    | ConversationStoreError
    | PermissionRequestNotFound
    | RequestAnswered
    | NotGrantable
    | GrantNotFound
    | PermissionStoreError,
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
    case "PermissionRequestNotFound":
      return OperatorHttpError.make({
        error: "PermissionRequestNotFound",
        message: `Permission request ${error.request} was not found in this conversation.`,
      });
    case "RequestAnswered":
      return OperatorHttpError.make({
        error: "RequestAnswered",
        message: `Permission request ${error.request} has an answer already. Nothing changed.`,
      });
    case "NotGrantable":
      return OperatorHttpError.make({
        error: "NotGrantable",
        message:
          "This operation is outside a project, so a standing grant can't cover it. Allow it once or deny it.",
      });
    case "GrantNotFound":
      return OperatorHttpError.make({
        error: "GrantNotFound",
        message: `Standing grant ${error.grant} was not found.`,
      });
    case "PermissionStoreError":
      return OperatorHttpError.make({
        error: "PermissionStoreError",
        message: `Permission store error: could not ${error.operation}.`,
      });
  }
};

/** The API view of `record` and its requests, without the credentials of its members. */
const conversationView = (
  { conversation, messages, turns }: ConversationRecord,
  requests: ReadonlyArray<Parameters<typeof requestView>[0]>,
) => ({
  conversation,
  messages,
  turns: turns.map(turnView),
  requests: requests.map(requestView),
});

const unavailable = "Conversations are unavailable until GitHub App setup is complete.";

const missing = () =>
  OperatorHttpError.make({
    error: "SupervisorNotReady",
    message: unavailable,
  });
/** The conversations of this server, or a refusal while it runs without them. */
const conversations = Effect.flatMap(Effect.serviceOption(Conversations), (found) =>
  Effect.fromOption(found).pipe(Effect.mapError(missing)),
);
/** The permissions of this server, or a refusal while it runs without conversations. */
const permissions = Effect.flatMap(Effect.serviceOption(Permissions), (found) =>
  Effect.fromOption(found).pipe(Effect.mapError(missing)),
);

/** The member who sends the request; a credential without a member is refused with `message`. */
const requireMember = (message: string) =>
  Effect.flatMap(RequestMember, (current) =>
    Option.match(current, {
      onNone: () =>
        Effect.logWarning("Conversation request refused for a credential without a member").pipe(
          Effect.andThen(Effect.fail(OperatorHttpError.make({ error: "AccessDenied", message }))),
        ),
      onSome: Effect.succeed,
    }),
  );

/** The credential of the request as a member acts with it: a device token, or a browser session. */
const requestCredential = Effect.map(RequestToken, (token): PostingCredential =>
  Option.match(
    Option.filter(token, ({ kind }) => kind === "device"),
    {
      onNone: () => PostedWithSession.make({}),
      onSome: ({ id }) => PostedWithToken.make({ tokenId: id }),
    },
  ),
);

/**
 * The member who sends the request, with the device token or browser session they send it with;
 * another credential can't post to the supervisor or answer its requests.
 */
const actor = (message: string) =>
  Effect.flatMap(requireMember(message), ({ id, login }) =>
    Effect.map(requestCredential, (credential) => ({
      member: TurnMember.make({ id, login }),
      credential,
    })),
  );
const poster = actor("Sign in as a member to talk to the supervisor.");

/** The member who reads, to say what they can answer or revoke; `None` for other credentials. */
const reader = Effect.flatMap(RequestMember, (member) =>
  Option.match(member, {
    onNone: () => Effect.succeedNone,
    onSome: ({ id, login }) =>
      Effect.map(requestCredential, (credential) =>
        Option.some({ member: TurnMember.make({ id, login }), credential }),
      ),
  }),
);

/** The handlers of the operator API's `conversation` group. */
export const conversationHandlers = HttpApiBuilder.group(OperatorApi, "conversation", (routes) =>
  routes
    .handle("conversationStatus", () =>
      Effect.gen(function* () {
        const found = yield* Effect.serviceOption(Conversations);
        if (Option.isNone(found)) return { state: "setup-required" as const, reason: unavailable };
        const status = yield* found.value.status;
        return status._tag === "SupervisorReady"
          ? { state: "ready" as const, reason: null }
          : { state: "setup-required" as const, reason: status.reason };
      }),
    )
    .handle("conversations", ({ query }) =>
      Effect.gen(function* () {
        const conversation = yield* conversations;
        const member = yield* RequestMember;
        const listed = yield* conversation
          .list(
            Option.fromUndefinedOr(query.anchor),
            Option.map(member, ({ id }) => id),
          )
          .pipe(Effect.mapError(failure));
        return { conversations: listed.map(summaryView) };
      }),
    )
    .handle("startConversation", ({ payload }) =>
      Effect.gen(function* () {
        const conversation = yield* conversations;
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
        const record = yield* conversation.start(request, caller).pipe(Effect.mapError(failure));
        return conversationView(record, []);
      }),
    )
    .handle("conversation", ({ params }) =>
      Effect.gen(function* () {
        const conversation = yield* conversations;
        const record = yield* conversation.read(params.conversation).pipe(Effect.mapError(failure));
        const service = yield* permissions;
        const viewer = yield* reader;
        const requests = yield* service
          .ofConversation(params.conversation, viewer)
          .pipe(Effect.mapError(failure));
        return conversationView(record, requests);
      }),
    )
    .handle("conversationEvents", ({ params, query }) =>
      Effect.gen(function* () {
        const conversation = yield* conversations;
        const after = query.after ?? 0;
        const events = yield* conversation
          .events(params.conversation, after, EVENTS_PAGE)
          .pipe(Effect.mapError(failure));
        return { events, next: events.at(-1)?.sequence ?? after };
      }),
    )
    .handle("postMessage", ({ params, payload }) =>
      Effect.gen(function* () {
        const conversation = yield* conversations;
        const caller = yield* poster;
        const posted = yield* conversation
          .post(
            params.conversation,
            { body: payload.body, format: payload.format, reply: payload.reply.format },
            caller,
          )
          .pipe(Effect.mapError(failure));
        return { message: posted.message, turn: turnView(posted.turn) };
      }),
    )
    .handle("markRead", ({ params, payload }) =>
      Effect.gen(function* () {
        const conversation = yield* conversations;
        const member = yield* requireMember("Sign in as a member to mark conversations read.");
        const marker = yield* conversation
          .markRead(params.conversation, payload.through, member.id)
          .pipe(Effect.mapError(failure));
        return readMarkerView(marker);
      }),
    )
    .handle("cancelTurn", ({ params }) =>
      Effect.gen(function* () {
        const conversation = yield* conversations;
        const caller = yield* poster;
        const turn = yield* conversation
          .cancel(params.conversation, params.turn, caller.member.login)
          .pipe(Effect.mapError(failure));
        return turnView(turn);
      }),
    )
    .handle("answerRequest", ({ params, payload }) =>
      Effect.gen(function* () {
        const conversation = yield* conversations;
        const caller = yield* actor("Sign in as a member to answer a permission request.");
        const request = yield* conversation
          .answer(params.conversation, params.request, payload.answer, caller)
          .pipe(Effect.mapError(failure));
        return requestView({ request, answerable: false });
      }),
    )
    .handle("supervisorGrants", () =>
      Effect.gen(function* () {
        const service = yield* permissions;
        const viewer = yield* reader;
        const grants = yield* service.grants(viewer).pipe(Effect.mapError(failure));
        return { grants: grants.map(grantView) };
      }),
    )
    .handle("revokeSupervisorGrant", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* actor("Sign in as a member to revoke a standing grant.");
        const service = yield* permissions;
        const revoked = yield* service.revoke(params.grant, caller).pipe(Effect.mapError(failure));
        return grantView(revoked);
      }),
    )
    .handle("supervisorActions", () =>
      Effect.gen(function* () {
        const service = yield* permissions;
        const actions = yield* service.actions(ACTIONS_PAGE).pipe(Effect.mapError(failure));
        return { actions: actions.map((request) => requestView({ request, answerable: false })) };
      }),
    ),
);
