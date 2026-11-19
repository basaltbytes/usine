import {
  AccessDenied,
  InstanceScope,
  permits,
  ProjectScope,
  RequestPermissions,
} from "@usine/core/access";
import { ChangeBus, type ScopedChange } from "@usine/core/changes";
import {
  type Conversation,
  type ConversationId,
  FollowUpPost,
  followUpOf,
  isOpen,
  MessageBody,
  type RunningTurn,
  type Turn,
  type TurnId,
} from "@usine/core/conversation";
import {
  allow,
  AllowedAlways,
  AllowedOnce,
  type AllowedRequest,
  type Answer,
  answeredByMember,
  covered,
  CoveredByGrant,
  covers,
  deny,
  GrantRevocation,
  grantRequirement,
  interrupt,
  isGrantable,
  isWaiting,
  needsReport,
  outcomeLine,
  type OperationCall,
  type PermissionRequest,
  PermissionRequestId,
  requested,
  settle,
  StandingGrant,
  StandingGrantId,
} from "@usine/core/permission-request";
import {
  type Brand,
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import { ConversationNotFound, ConversationStore, type ConversationStoreError } from "../store.ts";
import { ActingCalls, type ActorAccess, type Actor } from "./acting.ts";
import { type ActionAudience, PermissionStore, type PermissionStoreError } from "./store.ts";

/** No permission request of the conversation has this ID. */
export class PermissionRequestNotFound extends Schema.TaggedError<
  PermissionRequestNotFound,
  Brand.Brand<"@usine/orchestrator/conversation/permissions/PermissionRequestNotFound">
>("@usine/orchestrator/PermissionRequestNotFound")("PermissionRequestNotFound", {
  request: Schema.NonEmptyString,
}) {}

/** The request has an answer already, so a new answer changed nothing. */
export class RequestAnswered extends Schema.TaggedError<
  RequestAnswered,
  Brand.Brand<"@usine/orchestrator/conversation/permissions/RequestAnswered">
>("@usine/orchestrator/RequestAnswered")("RequestAnswered", {
  request: Schema.NonEmptyString,
}) {}

/** "Allow always" answered a call that no standing grant can cover. */
export class NotGrantable extends Schema.TaggedError<
  NotGrantable,
  Brand.Brand<"@usine/orchestrator/conversation/permissions/NotGrantable">
>("@usine/orchestrator/NotGrantable")("NotGrantable", {
  request: Schema.NonEmptyString,
}) {}

/** No standing grant that the caller can read has this ID. */
export class GrantNotFound extends Schema.TaggedError<
  GrantNotFound,
  Brand.Brand<"@usine/orchestrator/conversation/permissions/GrantNotFound">
>("@usine/orchestrator/GrantNotFound")("GrantNotFound", {
  grant: Schema.NonEmptyString,
}) {}

/** A turn called an operation outside its conversation's project. */
export class CallOutsideScope extends Schema.TaggedError<
  CallOutsideScope,
  Brand.Brand<"@usine/orchestrator/conversation/permissions/CallOutsideScope">
>("@usine/orchestrator/CallOutsideScope")("CallOutsideScope", {
  message: Schema.NonEmptyString,
}) {}

/** A permission request, and whether the reader can answer it now. */
export interface RequestEntry {
  readonly request: PermissionRequest;
  readonly answerable: boolean;
}

/** A standing grant, whether it applies now, and whether the reader can revoke it. */
export interface GrantEntry {
  readonly grant: StandingGrant;
  /** Whether the access of the member who allowed it still permits its operation. */
  readonly applies: boolean;
  readonly revocable: boolean;
}

/**
 * Supervisor turns' permission requests and members' standing grants. A turn's call of an
 * operation that needs more than `read` runs at once under a standing grant whose member's access
 * permits it now, and otherwise waits as a request for a member's answer. Every call runs as the
 * member who allowed it, with that member's access at that moment. When every request of an ended
 * turn has an answer, usine posts the outcomes and queues the turn that reports them.
 */
export class Permissions extends Context.Service<
  Permissions,
  {
    /**
     * Runs a running turn's `call` under a standing grant that covers it, or stores a waiting
     * request, and returns the request. A conversation on a project can request only calls in
     * that project: an operation outside a project, or on another project, fails.
     */
    readonly gate: (
      conversation: Conversation,
      turn: RunningTurn,
      call: OperationCall,
      toolCall: Option.Option<string>,
    ) => Effect.Effect<PermissionRequest, CallOutsideScope | PermissionStoreError>;
    /**
     * Applies `by`'s answer to a waiting request once, runs an allowed call, and returns the
     * request with its outcome. Once the answer is stored, the call, its outcome, the turn that
     * reports the outcomes, and `wake` for that turn's conversation finish even if the caller is
     * interrupted. Needs `read` on the conversation's scope, and fails with `AccessDenied` when
     * `by`'s access doesn't permit the call's operation in its scope.
     */
    readonly answer: (
      conversation: ConversationId,
      request: PermissionRequestId,
      answer: Answer,
      by: Actor,
      wake: (conversation: ConversationId) => Effect.Effect<void>,
    ) => Effect.Effect<
      PermissionRequest,
      | AccessDenied
      | ConversationNotFound
      | PermissionRequestNotFound
      | RequestAnswered
      | NotGrantable
      | PermissionStoreError
      | ConversationStoreError
    >;
    /** The requests of a conversation that the caller can read, oldest first. */
    readonly ofConversation: (
      conversation: ConversationId,
      reader: Option.Option<Actor>,
    ) => Effect.Effect<
      ReadonlyArray<RequestEntry>,
      ConversationNotFound | PermissionStoreError | ConversationStoreError
    >;
    /** The requests of `turn` that a member answered, oldest first. */
    readonly answeredOf: (
      turn: TurnId,
    ) => Effect.Effect<ReadonlyArray<PermissionRequest>, PermissionStoreError>;
    /**
     * Posts the outcomes of the requests of the ended `turn` and queues the turn that reports
     * them, when none waits or runs and a member answered one that no turn reported. Returns the
     * queued turn.
     */
    readonly followUp: (
      turn: Turn,
    ) => Effect.Effect<
      Option.Option<Turn>,
      PermissionStoreError | ConversationStoreError | ConversationNotFound
    >;
    /** The standing grants in projects that the caller can read, oldest first. */
    readonly grants: (
      reader: Option.Option<Actor>,
    ) => Effect.Effect<ReadonlyArray<GrantEntry>, PermissionStoreError>;
    /**
     * Revokes a standing grant. Fails with `AccessDenied` when `by`'s access doesn't permit the
     * grant's operation in its project. Revoking a revoked grant changes nothing.
     */
    readonly revoke: (
      grant: StandingGrantId,
      by: Actor,
    ) => Effect.Effect<GrantEntry, GrantNotFound | AccessDenied | PermissionStoreError>;
    /** The allowed calls in conversations that the caller can read, latest answer first. */
    readonly actions: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PermissionRequest>, PermissionStoreError>;
    /**
     * Ends each call that ran when the orchestrator stopped as interrupted, and queues the
     * follow-up turns that a stop left out. Returns the conversations with a queued follow-up.
     */
    readonly recover: Effect.Effect<ReadonlyArray<ConversationId>>;
  }
>()("@usine/orchestrator/conversation/permissions/permissions") {}

const actorOf = (grant: StandingGrant): Actor => ({
  member: grant.member,
  credential: grant.credential,
});

/** A key that identifies the member and credential of `actor`. */
const actorKey = ({ member, credential }: Actor) =>
  `${member.id}:${credential._tag === "PostedWithToken" ? credential.tokenId : "session"}`;

const noAccess: ActorAccess = { permits: () => false };

export const permissionsLayer = Layer.effect(
  Permissions,
  Effect.gen(function* () {
    const store = yield* PermissionStore;
    const conversations = yield* ConversationStore;
    const acting = yield* ActingCalls;
    const bus = yield* ChangeBus;
    const crypto = yield* Crypto.Crypto;
    const scope = yield* Effect.scope;
    const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
    const now = Effect.map(Clock.currentTimeMillis, (millis) => DateTime.makeUnsafe(millis));

    const notify = (request: PermissionRequest, grant: Option.Option<StandingGrantId>) => {
      const changes: Array<ScopedChange> = [
        {
          audience: request.audience,
          target: { kind: "conversation", id: request.conversation },
        },
      ];
      if (request.state._tag !== "Waiting" && request.state._tag !== "Denied")
        changes.push({
          audience: request.audience,
          target: { kind: "permission", id: request.id },
        });
      if (Option.isSome(grant) && request.call.scope._tag === "Project")
        changes.push({
          audience: request.call.scope,
          target: { kind: "permission", id: grant.value },
        });
      return bus.publish(changes);
    };

    /** The access of `actor`, or none after logging why the member can't act. */
    const accessOf = (actor: Actor) =>
      acting.access(actor).pipe(
        Effect.tapError(({ message }) =>
          Effect.logInfo("Member can't act", { member: actor.member.login, reason: message }),
        ),
        Effect.option,
      );

    /** The conversation `id`, or not found when it is absent or the caller can't read it. */
    const readable = Effect.fn("Permissions.readable")(function* (id: ConversationId) {
      const record = yield* conversations.get(id);
      const grants = yield* RequestPermissions;
      if (Option.isSome(record) && permits(grants, "read", record.value.conversation.scope))
        return record.value;
      return yield* ConversationNotFound.make({ conversation: id });
    });

    /** The first grant that covers `call` and whose member's access permits it now. */
    const applicableGrant = Effect.fn("Permissions.applicableGrant")(function* (
      call: OperationCall,
    ) {
      if (!isGrantable(call)) return Option.none<StandingGrant>();
      const candidates = (yield* store.grants).filter((grant) => covers(grant, call));
      for (const grant of candidates) {
        const access = yield* accessOf(actorOf(grant));
        if (Option.isSome(access) && access.value.permits(call)) return Option.some(grant);
        yield* Effect.logInfo("Standing grant skipped: its member's access no longer permits it", {
          grant: grant.id,
          member: grant.member.login,
          operation: call.operation,
        });
      }
      return Option.none<StandingGrant>();
    });

    const followUp = Effect.fn("Permissions.followUp")(function* (turn: Turn) {
      yield* Effect.annotateCurrentSpan({ conversation: turn.conversation, turn: turn.id });
      if (isOpen(turn)) return Option.none<Turn>();
      const requests = yield* store.ofTurn(turn.id);
      if (!needsReport(requests)) return Option.none<Turn>();
      const reported = requests.filter(answeredByMember);
      const at = yield* now;
      const posted = yield* conversations.followUp(
        FollowUpPost.make({
          conversation: turn.conversation,
          reports: turn.id,
          member: turn.member,
          credential: turn.credential,
          body: MessageBody.make(reported.map(outcomeLine).join("\n")),
          reply: turn.reply,
          at,
        }),
      );
      yield* store.report(turn.id, followUpOf(turn.id));
      const audience = requests[0]?.audience;
      if (Option.isSome(posted) && audience !== undefined)
        yield* bus.publish([{ audience, target: { kind: "conversation", id: turn.conversation } }]);
      yield* Effect.logInfo(
        Option.isSome(posted)
          ? "Queued the turn that reports permission request outcomes"
          : "Permission request outcomes were already queued",
        { conversation: turn.conversation, turn: turn.id, requests: reported.length },
      );
      return posted;
    });

    /** Queues the follow-up of the turn of `request` once it ended; logs a failure instead. */
    const followUpOfRequest = (request: PermissionRequest) =>
      Effect.gen(function* () {
        const record = yield* conversations.get(request.conversation);
        const turn = Option.flatMap(record, ({ turns }) =>
          Option.fromUndefinedOr(turns.find(({ id }) => id === request.turn)),
        );
        if (Option.isNone(turn)) return Option.none<Turn>();
        return yield* followUp(turn.value);
      }).pipe(
        Effect.catchTags({
          ConversationStoreError: ({ operation }) =>
            Effect.logError("Follow-up turn not queued; the next start retries", {
              operation,
            }).pipe(Effect.as(Option.none<Turn>())),
          PermissionStoreError: ({ operation }) =>
            Effect.logError("Follow-up turn not queued; the next start retries", {
              operation,
            }).pipe(Effect.as(Option.none<Turn>())),
          ConversationNotFound: () =>
            Effect.logInfo("Follow-up turn not queued: the conversation is gone", {
              conversation: request.conversation,
            }).pipe(Effect.as(Option.none<Turn>())),
        }),
      );

    /** Runs the allowed call of `request` as `actor` and stores its outcome. */
    const settleCall = (request: AllowedRequest, actor: Actor) =>
      Effect.gen(function* () {
        const outcome = yield* acting.run(actor, request.call);
        const at = yield* now;
        const settled = settle(request, at, outcome);
        yield* store.transition(request, settled, Option.none());
        const { allowance } = request.state;
        yield* notify(
          settled,
          allowance._tag === "AllowedOnce" ? Option.none() : Option.some(allowance.grant),
        );
        yield* Effect.logInfo("Supervisor turn's call ran", {
          conversation: request.conversation,
          turn: request.turn,
          request: request.id,
          operation: request.call.operation,
          target: request.call.target,
          allowance: allowance._tag,
          grant: allowance._tag === "AllowedOnce" ? "none" : allowance.grant,
          allowedBy: allowance.by.login,
          outcome: settled.state._tag,
        });
        return settled;
      }).pipe(
        Effect.withSpan("Permissions.settleCall", {
          attributes: { request: request.id, operation: request.call.operation },
        }),
      );

    /**
     * Runs `effect` in the layer's scope and waits for it, so an interrupted caller, such as a
     * canceled turn or a closed HTTP request, leaves it to finish.
     */
    const detached = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));

    const grantEntry = (
      grant: StandingGrant,
      reader: Option.Option<ActorAccess>,
      cache: Map<string, Option.Option<ActorAccess>>,
    ) =>
      Effect.gen(function* () {
        const key = actorKey(actorOf(grant));
        const access = cache.get(key) ?? (yield* accessOf(actorOf(grant)));
        cache.set(key, access);
        const requirement = grantRequirement(grant);
        return {
          grant,
          applies:
            Option.isNone(grant.revoked) &&
            Option.getOrElse(access, () => noAccess).permits(requirement),
          revocable: Option.getOrElse(reader, () => noAccess).permits(requirement),
        } satisfies GrantEntry;
      });

    const recover = Effect.gen(function* () {
      const running = yield* store.running;
      for (const request of running) {
        const at = yield* now;
        yield* store.transition(request, interrupt(request, at), Option.none());
        yield* Effect.logWarning("Supervisor turn's call interrupted by a restart", {
          conversation: request.conversation,
          turn: request.turn,
          request: request.id,
          operation: request.call.operation,
        });
      }
      const turns = yield* store.unreported;
      const followed: Array<ConversationId> = [];
      for (const turn of turns) {
        const [first] = yield* store.ofTurn(turn);
        if (first === undefined) continue;
        const posted = yield* followUpOfRequest(first);
        if (Option.isSome(posted)) followed.push(posted.value.conversation);
      }
      yield* Effect.logInfo("Permission requests recovered", {
        interrupted: running.length,
        followUps: followed.length,
      });
      return followed;
    }).pipe(
      Effect.catchTags({
        PermissionStoreError: ({ operation }) =>
          Effect.logError("Permission requests not recovered; the next start retries", {
            operation,
          }).pipe(Effect.as([])),
        RequestConflict: ({ request }) =>
          Effect.logError("Permission requests not recovered: a request changed during recovery", {
            request,
          }).pipe(Effect.as([])),
      }),
      Effect.withSpan("Permissions.recover"),
    );

    return Permissions.of({
      gate: Effect.fn("Permissions.gate")(function* (conversation, turn, call, toolCall) {
        yield* Effect.annotateCurrentSpan({
          conversation: conversation.id,
          turn: turn.id,
          operation: call.operation,
        });
        // Every reader of a project conversation reads its requests and their results.
        if (conversation.scope._tag === "Project") {
          const { project } = conversation.scope;
          const outside =
            call.scope._tag === "Instance"
              ? `${call.summary} is an operation outside a project. A conversation on project ${project} can request only operations in that project; ask for it in a conversation on the instance.`
              : call.scope.project === project
                ? undefined
                : `${call.target} was not found in project ${project}.`;
          if (outside !== undefined) {
            yield* Effect.logInfo("Supervisor call refused: it is outside the project", {
              conversation: conversation.id,
              operation: call.operation,
              scope: call.scope._tag,
            });
            return yield* CallOutsideScope.make({ message: outside });
          }
        }
        const id = yield* newId;
        const fields = {
          id: PermissionRequestId.make(id),
          conversation: conversation.id,
          audience: conversation.scope,
          turn: turn.id,
          toolCall,
          call,
          requestedAt: yield* now,
        };
        const grant = yield* applicableGrant(call);
        if (Option.isSome(grant)) {
          const request = covered(
            fields,
            CoveredByGrant.make({
              by: grant.value.member,
              at: fields.requestedAt,
              grant: grant.value.id,
            }),
          );
          yield* store.create(request, Option.some(grant.value.id));
          yield* notify(request, Option.some(grant.value.id));
          return yield* detached(settleCall(request, actorOf(grant.value))).pipe(
            Effect.catchTag("RequestConflict", ({ request: id }) =>
              Effect.die(new Error(`Permission request ${id} changed while its call ran`)),
            ),
          );
        }
        const request = requested(fields);
        yield* store.create(request, Option.none());
        yield* notify(request, Option.none());
        yield* Effect.logInfo("Supervisor turn requested permission", {
          conversation: conversation.id,
          turn: turn.id,
          request: request.id,
          operation: call.operation,
          target: call.target,
        });
        return request;
      }),
      answer: Effect.fn("Permissions.answer")(
        function* (conversationId, requestId, answer, by, wake) {
          yield* Effect.annotateCurrentSpan({
            conversation: conversationId,
            request: requestId,
            answer,
            member: by.member.login,
          });
          yield* readable(conversationId);
          const found = yield* store.get(requestId);
          const stored = Option.filter(
            found,
            ({ conversation }) => conversation === conversationId,
          );
          if (Option.isNone(stored))
            return yield* PermissionRequestNotFound.make({ request: requestId });
          const request = stored.value;
          if (!isWaiting(request)) {
            yield* Effect.logInfo("Answer ignored: the request has an answer", {
              request: requestId,
              state: request.state._tag,
            });
            return yield* RequestAnswered.make({ request: requestId });
          }
          if (answer === "always" && !isGrantable(request.call))
            return yield* NotGrantable.make({ request: requestId });
          const access = yield* accessOf(by);
          if (!Option.getOrElse(access, () => noAccess).permits(request.call)) {
            yield* Effect.logWarning(
              "Answer refused: the member's access doesn't permit the call",
              {
                request: requestId,
                member: by.member.login,
                operation: request.call.operation,
              },
            );
            return yield* AccessDenied.make({ permission: request.call.permission });
          }
          const at = yield* now;
          const conflict = () => RequestAnswered.make({ request: requestId });
          const { scope: callScope } = request.call;
          const grant =
            answer === "always" && callScope._tag === "Project"
              ? Option.some(
                  StandingGrant.make({
                    id: StandingGrantId.make(`${requestId}:grant`),
                    operation: request.call.operation,
                    summary: request.call.summary,
                    permission: request.call.permission,
                    project: callScope.project,
                    member: by.member,
                    credential: by.credential,
                    request: requestId,
                    createdAt: at,
                    lastUsedAt: Option.none(),
                    revoked: Option.none(),
                  }),
                )
              : Option.none<StandingGrant>();
          /** Stores the answer, runs an allowed call, and reports the outcomes. */
          const apply = Effect.gen(function* () {
            if (answer === "deny") {
              const denied = deny(request, by.member, at);
              yield* store
                .transition(request, denied, Option.none())
                .pipe(Effect.catchTag("RequestConflict", () => Effect.fail(conflict())));
              yield* notify(denied, Option.none());
              yield* Effect.logInfo("Permission request denied", {
                conversation: conversationId,
                turn: request.turn,
                request: requestId,
                member: by.member.login,
              });
              return denied;
            }
            const allowed = allow(
              request,
              Option.match(grant, {
                onNone: () => AllowedOnce.make({ by: by.member, at }),
                onSome: ({ id }) => AllowedAlways.make({ by: by.member, at, grant: id }),
              }),
            );
            yield* store
              .transition(request, allowed, grant)
              .pipe(Effect.catchTag("RequestConflict", () => Effect.fail(conflict())));
            yield* notify(
              allowed,
              Option.map(grant, ({ id }) => id),
            );
            yield* Effect.logInfo("Permission request allowed", {
              conversation: conversationId,
              turn: request.turn,
              request: requestId,
              member: by.member.login,
              answer,
              grant: Option.getOrElse(
                Option.map(grant, ({ id }) => id),
                () => "none",
              ),
            });
            return yield* settleCall(allowed, by).pipe(
              Effect.catchTag("RequestConflict", () => Effect.fail(conflict())),
            );
          }).pipe(
            Effect.tap((settled) =>
              followUpOfRequest(settled).pipe(
                Effect.flatMap((posted) =>
                  Option.isSome(posted) ? wake(posted.value.conversation) : Effect.void,
                ),
              ),
            ),
          );
          return yield* detached(apply);
        },
      ),
      ofConversation: Effect.fn("Permissions.ofConversation")(function* (id, reader) {
        yield* readable(id);
        const requests = yield* store.ofConversation(id);
        const access = requests.some(isWaiting)
          ? yield* Effect.transposeOption(Option.map(reader, accessOf)).pipe(
              Effect.map(Option.flatten),
            )
          : Option.none<ActorAccess>();
        const check = Option.getOrElse(access, () => noAccess);
        return requests.map((request) => ({
          request,
          answerable: isWaiting(request) && check.permits(request.call),
        }));
      }),
      answeredOf: (turn) =>
        Effect.map(store.ofTurn(turn), (requests) => requests.filter(answeredByMember)),
      followUp,
      grants: Effect.fn("Permissions.grants")(function* (reader) {
        const permissions = yield* RequestPermissions;
        const all = (yield* store.grants).filter(({ project }) =>
          permits(permissions, "read", ProjectScope.make({ project })),
        );
        const access = yield* Effect.transposeOption(Option.map(reader, accessOf)).pipe(
          Effect.map(Option.flatten),
        );
        const cache = new Map<string, Option.Option<ActorAccess>>();
        return yield* Effect.forEach(all, (grant) => grantEntry(grant, access, cache));
      }),
      revoke: Effect.fn("Permissions.revoke")(function* (id, by) {
        yield* Effect.annotateCurrentSpan({ grant: id, member: by.member.login });
        const permissions = yield* RequestPermissions;
        const found = yield* store.grant(id);
        const stored = Option.filter(found, ({ project }) =>
          permits(permissions, "read", ProjectScope.make({ project })),
        );
        if (Option.isNone(stored)) return yield* GrantNotFound.make({ grant: id });
        const requirement = grantRequirement(stored.value);
        const access = yield* accessOf(by);
        if (!Option.getOrElse(access, () => noAccess).permits(requirement)) {
          yield* Effect.logWarning(
            "Grant revocation refused: the member's access doesn't permit it",
            {
              grant: id,
              member: by.member.login,
            },
          );
          return yield* AccessDenied.make({ permission: requirement.permission });
        }
        const at = yield* now;
        const revoked = yield* store.revoke(id, GrantRevocation.make({ by: by.member.login, at }));
        if (Option.isNone(revoked)) return yield* GrantNotFound.make({ grant: id });
        yield* bus.publish([
          {
            audience: ProjectScope.make({ project: revoked.value.project }),
            target: { kind: "permission", id },
          },
        ]);
        yield* Effect.logInfo("Standing grant revoked", {
          grant: id,
          operation: revoked.value.operation,
          project: revoked.value.project,
          member: by.member.login,
        });
        return yield* grantEntry(revoked.value, access, new Map());
      }),
      actions: Effect.fn("Permissions.actions")(function* (limit) {
        const permissions = yield* RequestPermissions;
        const audience: ActionAudience = permits(permissions, "read", InstanceScope.make())
          ? { _tag: "Everyone" }
          : {
              _tag: "Projects",
              projects: [
                ...new Set(
                  permissions.flatMap(({ permission, scope }) =>
                    permission === "read" && scope._tag === "Project" ? [scope.project] : [],
                  ),
                ),
              ],
            };
        return yield* store.actions(limit, audience);
      }),
      recover,
    });
  }),
);
