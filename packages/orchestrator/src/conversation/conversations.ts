import type { Harnesses } from "@usine/agents/harness/registry";
import {
  SandboxRequest,
  SupervisorSandbox,
  SupervisorTurn,
  type SupervisorUnavailable,
} from "@usine/agents/supervisor";
import {
  type AccessScope,
  AccessDenied,
  type GitHubUserId,
  type Permission,
  permits,
  RequestPermissions,
} from "@usine/core/access";
import {
  AgentSessionId,
  type AgentSessionEvent,
  SessionTokensUpdated,
} from "@usine/core/agent/session";
import { ChangeBus } from "@usine/core/changes";
import {
  type AnchorKey,
  type AnchorKind,
  anchorOf,
  type AnchorReference,
  bodyText,
  cancelTurn,
  Conversation,
  ConversationId,
  ConversationTitle,
  type EndedTurn,
  type EventSequence,
  failTurn,
  Interrupted,
  isOpen,
  isQueued,
  isRunning,
  MemberPost,
  MessageBody,
  type MessageFormat,
  MessageSequence,
  type PostingCredential,
  type QueuedTurn,
  Reply,
  resumePoint,
  type RunningTurn,
  startTurn,
  succeedTurn,
  type Turn,
  TurnError,
  type TurnEvent,
  type TurnFailure,
  TurnId,
  type TurnMember,
} from "@usine/core/conversation";
import type { OperatorLogin } from "@usine/core/operator";
import type { RepositoryName } from "@usine/core/repository";
import {
  Array as Arr,
  type Brand,
  Cause,
  Clock,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect";
import { CurrentInstance } from "../current-instance/current-instance.ts";
import { visibleRepository } from "../operator/access.ts";
import { SupervisorSourceTrees } from "../supervisor-sandbox.ts";
import { TurnAccess } from "./access.ts";
import { turnPrompt } from "./context.ts";
import {
  ConversationNotFound,
  type ConversationRecord,
  ConversationStore,
  type ConversationStoreError,
  type ConversationSummary,
  lastActivity,
  type Posted,
  ReadMarker,
  type TurnConflict,
} from "./store.ts";

/** This orchestrator can run supervisor turns. */
export class SupervisorReady extends Schema.TaggedClass<
  SupervisorReady,
  Brand.Brand<"@usine/orchestrator/conversation/conversations/SupervisorReady">
>("SupervisorStatus/SupervisorReady")("SupervisorReady", {}) {}

/** This orchestrator can't run supervisor turns until `reason` is fixed. */
export class SupervisorSetupRequired extends Schema.TaggedClass<
  SupervisorSetupRequired,
  Brand.Brand<"@usine/orchestrator/conversation/conversations/SupervisorSetupRequired">
>("SupervisorStatus/SupervisorSetupRequired")("SupervisorSetupRequired", {
  reason: Schema.NonEmptyString,
}) {}

export const SupervisorStatus = Schema.Union([SupervisorReady, SupervisorSetupRequired]);
export type SupervisorStatus = typeof SupervisorStatus.Type;

/** The supervisor can't take a new message on this orchestrator. */
export class SupervisorNotReady extends Schema.TaggedError<
  SupervisorNotReady,
  Brand.Brand<"@usine/orchestrator/conversation/conversations/SupervisorNotReady">
>("@usine/orchestrator/SupervisorNotReady")("SupervisorNotReady", {
  message: Schema.NonEmptyString,
}) {}

/** No turn of the conversation has this ID. */
export class TurnNotFound extends Schema.TaggedError<
  TurnNotFound,
  Brand.Brand<"@usine/orchestrator/conversation/conversations/TurnNotFound">
>("@usine/orchestrator/TurnNotFound")("TurnNotFound", {
  conversation: ConversationId,
  turn: TurnId,
}) {}

/** A project scope that the instance doesn't configure. */
export class UnknownProject extends Schema.TaggedError<
  UnknownProject,
  Brand.Brand<"@usine/orchestrator/conversation/conversations/UnknownProject">
>("@usine/orchestrator/UnknownProject")("UnknownProject", {
  message: Schema.NonEmptyString,
}) {}

/** Who posts a message: the member, and the credential they post with. */
export interface Poster {
  readonly member: TurnMember;
  readonly credential: PostingCredential;
}

/** A member message, and the format that the member asks the answer to use. */
export interface MessageRequest {
  readonly format: MessageFormat;
  readonly body: MessageBody;
  readonly reply: MessageFormat;
}

/** What a member sends to start a conversation. */
export interface ConversationRequest {
  readonly scope: AccessScope;
  readonly anchor: Option.Option<{
    readonly kind: AnchorKind;
    readonly reference: AnchorReference;
  }>;
  readonly title: Option.Option<ConversationTitle>;
  readonly message: MessageRequest;
}

/**
 * Members' conversations with the supervisor. Reads need `read` on the conversation's scope, and
 * a conversation that the member can't read is not found. Writes need `operate`. A conversation
 * runs one turn at a time, in message order, each with the access of the member who posted its
 * message. Every change publishes a `conversation` change notice to the scope's readers.
 */
export class Conversations extends Context.Service<
  Conversations,
  {
    readonly status: Effect.Effect<SupervisorStatus>;
    /**
     * The conversations that the caller can read, with the anchor `key` or all, latest activity
     * first. With a `reader`, each says whether it is unread for that member.
     */
    readonly list: (
      key: Option.Option<AnchorKey>,
      reader: Option.Option<GitHubUserId>,
    ) => Effect.Effect<ReadonlyArray<ConversationSummary>, ConversationStoreError>;
    /**
     * Marks `id` read by `member` through the message `through`, or through its last message if
     * `through` is later. Needs `read` on the scope. A marker never moves back, and marking read
     * notifies no one.
     */
    readonly markRead: (
      id: ConversationId,
      through: MessageSequence,
      member: GitHubUserId,
    ) => Effect.Effect<ReadMarker, ConversationNotFound | ConversationStoreError>;
    readonly start: (
      request: ConversationRequest,
      poster: Poster,
    ) => Effect.Effect<
      ConversationRecord,
      AccessDenied | SupervisorNotReady | UnknownProject | ConversationStoreError
    >;
    readonly read: (
      id: ConversationId,
    ) => Effect.Effect<ConversationRecord, ConversationNotFound | ConversationStoreError>;
    /** At most `limit` events after `after`, in order. */
    readonly events: (
      id: ConversationId,
      after: EventSequence | 0,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<TurnEvent>, ConversationNotFound | ConversationStoreError>;
    /** Appends a member message and queues its turn behind the conversation's earlier turns. */
    readonly post: (
      id: ConversationId,
      message: MessageRequest,
      poster: Poster,
    ) => Effect.Effect<
      Posted,
      AccessDenied | ConversationNotFound | SupervisorNotReady | ConversationStoreError
    >;
    /**
     * Cancels a queued turn, or stops a running one and keeps its events. Returns the turn once
     * its end is stored: canceled, or the state it reached first.
     */
    readonly cancel: (
      id: ConversationId,
      turn: TurnId,
      by: OperatorLogin,
    ) => Effect.Effect<
      Turn,
      AccessDenied | ConversationNotFound | TurnNotFound | ConversationStoreError | TurnConflict
    >;
  }
>()("@usine/orchestrator/conversation/conversations") {}

/** Why a running turn ended without an answer, with the usage it reported. */
class TurnStopped extends Schema.TaggedError<
  TurnStopped,
  Brand.Brand<"@usine/orchestrator/conversation/conversations/TurnStopped">
>("@usine/orchestrator/TurnStopped")("TurnStopped", {
  failure: TurnError,
  usage: Schema.Option(SessionTokensUpdated),
}) {}

/** The running turn of a conversation's worker. */
interface Active {
  readonly turn: TurnId;
  readonly cancel: Deferred.Deferred<OperatorLogin>;
  /** The turn once its end is stored. */
  readonly ended: Deferred.Deferred<Turn>;
}

interface Worker {
  /** Whether a message arrived after the worker last looked for a queued turn. */
  readonly pending: boolean;
  readonly active: Option.Option<Active>;
}

/** How many events a page of the restart scan reads. */
const EVENT_PAGE = 500;

const notConfigured = "No supervisor is configured. Set settings.supervisor.";

/** The first non-blank line of `text`, at most 80 characters. */
const titleOf = (text: string) => {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  return ConversationTitle.make(line === undefined ? "Conversation" : line.slice(0, 80));
};

const isUsage = (event: AgentSessionEvent): event is SessionTokensUpdated =>
  event._tag === "SessionTokensUpdated";

/** The last usage that the stored events of `turn` reported. */
const storedUsage = Effect.fn("Conversations.storedUsage")(function* (
  store: ConversationStore["Service"],
  turn: Turn,
) {
  let after: EventSequence | 0 = 0;
  let usage = Option.none<SessionTokensUpdated>();
  while (true) {
    const page: ReadonlyArray<TurnEvent> = yield* store.events(
      turn.conversation,
      after,
      EVENT_PAGE,
    );
    const own = page.flatMap(({ turn: id, event }) => (id === turn.id ? [event] : []));
    usage = Option.orElse(Arr.findLast(own, isUsage), () => usage);
    const last = page.at(-1);
    if (last === undefined || page.length < EVENT_PAGE) return usage;
    after = last.sequence;
  }
});

/**
 * Runs members' conversations with the supervisor. At startup, a turn that was running ends as
 * `failed` with the interrupted marker, and queued turns run.
 */
export const conversationsLayer = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const store = yield* ConversationStore;
    const access = yield* TurnAccess;
    const sandbox = yield* SupervisorSandbox;
    const sources = yield* SupervisorSourceTrees;
    const instances = yield* CurrentInstance;
    const bus = yield* ChangeBus;
    const crypto = yield* Crypto.Crypto;
    const harnesses = yield* Effect.context<Harnesses>();
    const scope = yield* Effect.scope;
    const workers = yield* SynchronizedRef.make(new Map<ConversationId, Worker>());

    const notify = (conversation: Conversation) =>
      bus.publish([
        { audience: conversation.scope, target: { kind: "conversation", id: conversation.id } },
      ]);
    const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
    const now = Effect.map(Clock.currentTimeMillis, (millis) => DateTime.makeUnsafe(millis));
    const brain = Effect.map(instances.get, ({ config }) => config.settings.supervisor);

    const status = Effect.gen(function* () {
      const configured = yield* brain;
      if (Option.isNone(configured)) return SupervisorSetupRequired.make({ reason: notConfigured });
      return Option.match(sandbox.unavailable, {
        onNone: (): SupervisorStatus => SupervisorReady.make({}),
        onSome: ({ message }) => SupervisorSetupRequired.make({ reason: message }),
      });
    }).pipe(Effect.withSpan("Conversations.status"));
    const requireReady = Effect.gen(function* () {
      const current = yield* status;
      if (current._tag === "SupervisorReady") return;
      yield* Effect.logInfo("Supervisor message refused: setup required", {
        reason: current.reason,
      });
      return yield* SupervisorNotReady.make({ message: current.reason });
    });
    const requireOn = Effect.fn("Conversations.requireOn")(function* (
      permission: Permission,
      conversation: Conversation,
    ) {
      const grants = yield* RequestPermissions;
      if (permits(grants, permission, conversation.scope)) return;
      yield* Effect.logWarning("Conversation permission refused", {
        conversation: conversation.id,
        permission,
      });
      return yield* AccessDenied.make({ permission });
    });
    /** The record of `id`, or not found when it is absent or the member can't read it. */
    const readable = Effect.fn("Conversations.readable")(function* (id: ConversationId) {
      const record = yield* store.get(id);
      const grants = yield* RequestPermissions;
      if (Option.isSome(record) && permits(grants, "read", record.value.conversation.scope))
        return record.value;
      return yield* ConversationNotFound.make({ conversation: id });
    });
    /** The repositories in `scope` that `grants` can read, whose source the turn mounts. */
    const repositoriesFor = (scope: AccessScope, grants: Parameters<typeof permits>[0]) =>
      Effect.map(instances.get, (instance): ReadonlyArray<RepositoryName> => {
        const inScope =
          scope._tag === "Project"
            ? (instance.config.projects.find(({ id }) => id === scope.project)?.repositories ?? [])
            : instance.config.repos.map(({ name }) => name);
        return inScope.filter((repository) => visibleRepository(instance, grants, repository));
      });

    /**
     * Runs `running` in the supervisor sandbox with the member's access and passes each session
     * event to `observe`. Interrupting it stops the session and removes the sandbox.
     */
    const execute = (
      record: ConversationRecord,
      running: RunningTurn,
      observe: (event: AgentSessionEvent) => Effect.Effect<void>,
    ) =>
      Effect.gen(function* () {
        const { conversation } = record;
        const stopped = (message: string) =>
          TurnStopped.make({ failure: TurnError.make({ message }), usage: Option.none() });
        const unavailable = ({ message }: SupervisorUnavailable) => stopped(message);
        const configured = yield* brain;
        if (Option.isNone(configured)) return yield* stopped(notConfigured);
        const supervisorBrain = configured.value;
        const member = yield* access
          .open(running.member, running.credential, conversation.scope)
          .pipe(Effect.mapError(({ message }) => stopped(message)));
        if (!permits(member.posterGrants, "operate", conversation.scope))
          return yield* stopped(
            `${running.member.login} can no longer operate on ${conversation.scope._tag === "Project" ? `project ${conversation.scope.project}` : "the instance"}, so the turn didn't run.`,
          );
        const repositories = yield* repositoriesFor(conversation.scope, member.grants);
        const trees = yield* sources.prepare(repositories).pipe(Effect.mapError(unavailable));
        const seat = yield* sandbox
          .open(
            SandboxRequest.make({
              conversation: AgentSessionId.make(conversation.id),
              harness: supervisorBrain.harness,
              model: supervisorBrain.model,
              sources: trees,
            }),
          )
          .pipe(Effect.mapError(unavailable));
        const message = record.messages.find(({ sequence }) => sequence === running.message);
        if (message === undefined)
          return yield* Effect.die(new Error(`Turn ${running.id} has no stored message`));
        const text = yield* bodyText(message.body);
        const prompt = yield* turnPrompt({
          member: running.member,
          grants: member.grants,
          at: running.state.startedAt,
          conversation,
          repositories,
          needsYou: member.needsYou,
          needsTotal: member.needsTotal,
          reply: running.reply,
          text,
        });
        const resume = resumePoint(
          record.turns.filter(({ message: sequence }) => sequence < running.message),
        );
        return yield* member
          .run(
            SupervisorTurn.make({
              session: AgentSessionId.make(conversation.id),
              brain: supervisorBrain,
              seat,
              saved: resume.session,
              usage: resume.usage,
              message: prompt,
            }),
            observe,
          )
          .pipe(
            Effect.provide(harnesses),
            Effect.mapError((error) =>
              TurnStopped.make({
                failure: TurnError.make({ message: error.message }),
                usage: error._tag === "SupervisorTurnError" ? error.usage : Option.none(),
              }),
            ),
          );
      }).pipe(Effect.scoped);

    const ended = Effect.fn("Conversations.ended")(function* (
      conversation: Conversation,
      running: RunningTurn,
      next: EndedTurn,
    ) {
      yield* store.transition(running, next);
      yield* notify(conversation);
      return next;
    });
    const fail = (
      conversation: Conversation,
      running: RunningTurn,
      failure: TurnFailure,
      usage: Option.Option<SessionTokensUpdated>,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Supervisor turn failed", {
          conversation: running.conversation,
          turn: running.id,
          failure: failure._tag,
          reason: failure._tag === "TurnError" ? failure.message : "The orchestrator stopped",
        });
        const at = yield* now;
        return yield* ended(conversation, running, failTurn(running, at, failure, usage));
      });

    /**
     * Runs `queued` to its end and stores the end. Its session events are stored as they arrive,
     * and a cancel or a failure keeps them.
     */
    const runTurn = Effect.fn("Conversations.runTurn")(function* (
      record: ConversationRecord,
      queued: QueuedTurn,
      active: Active,
    ) {
      const { conversation } = record;
      yield* Effect.annotateCurrentSpan({ conversation: conversation.id, turn: queued.id });
      const startedAt = yield* now;
      const running = startTurn(queued, startedAt);
      yield* store.transition(queued, running);
      yield* notify(conversation);
      yield* Effect.logInfo("Supervisor turn started", {
        conversation: conversation.id,
        turn: queued.id,
        member: queued.member.login,
      });
      const seen = yield* Ref.make(Option.none<SessionTokensUpdated>());
      const events = yield* Queue.unbounded<AgentSessionEvent, Cause.Done>();
      const persister = yield* Stream.fromQueue(events).pipe(
        Stream.runForEachArray((batch) =>
          store.append(running, batch).pipe(Effect.andThen(notify(conversation))),
        ),
        Effect.forkScoped,
      );
      const observe = (event: AgentSessionEvent) =>
        Queue.offer(events, event).pipe(
          Effect.andThen(isUsage(event) ? Ref.set(seen, Option.some(event)) : Effect.void),
        );
      const outcome = yield* execute(record, running, observe).pipe(
        Effect.result,
        Effect.map((result) => ({ _tag: "Ended" as const, result })),
        Effect.raceFirst(
          Deferred.await(active.cancel).pipe(
            Effect.map((by) => ({ _tag: "Canceled" as const, by })),
          ),
        ),
      );
      yield* Queue.end(events);
      const stored = yield* Fiber.join(persister).pipe(Effect.result);
      const usage = yield* Ref.get(seen);
      if (stored._tag === "Failure") {
        yield* Effect.logError("Supervisor turn events could not be stored", {
          conversation: conversation.id,
          turn: running.id,
          operation: stored.failure.operation,
        });
        return yield* fail(
          conversation,
          running,
          TurnError.make({ message: "usine couldn't store the turn's events." }),
          usage,
        );
      }
      if (outcome._tag === "Canceled") {
        yield* Effect.logInfo("Supervisor turn canceled", {
          conversation: conversation.id,
          turn: running.id,
          by: outcome.by,
        });
        const at = yield* now;
        return yield* ended(conversation, running, cancelTurn(running, at, outcome.by, usage));
      }
      if (outcome.result._tag === "Failure") {
        const { failure, usage: reported } = outcome.result.failure;
        return yield* fail(
          conversation,
          running,
          failure,
          Option.orElse(reported, () => usage),
        );
      }
      const reply = outcome.result.success;
      const body = Schema.decodeOption(MessageBody)(reply.message);
      if (Option.isNone(body))
        return yield* fail(
          conversation,
          running,
          TurnError.make({ message: "The supervisor returned an empty answer." }),
          reply.usage,
        );
      const at = yield* now;
      const succeeded = succeedTurn(running, at, reply.saved, reply.usage);
      yield* store.answer(running, succeeded, Reply.make({ body: body.value, at }));
      yield* notify(conversation);
      yield* Effect.logInfo("Supervisor turn answered", {
        conversation: conversation.id,
        turn: running.id,
        events: reply.events.length,
      });
      return succeeded;
    }, Effect.scoped);

    /** Runs the conversation's queued turns in message order until none is left. */
    const drain = Effect.fn("Conversations.drain")(function* (id: ConversationId) {
      while (true) {
        const record = yield* store.get(id);
        const next = Option.flatMap(record, ({ turns }) =>
          Option.fromUndefinedOr(turns.find(isQueued)),
        );
        if (Option.isNone(record) || Option.isNone(next)) {
          const again = yield* SynchronizedRef.modify(workers, (all) => {
            const copy = new Map(all);
            if (all.get(id)?.pending === true) {
              copy.set(id, { pending: false, active: Option.none() });
              return [true, copy];
            }
            copy.delete(id);
            return [false, copy];
          });
          if (again) continue;
          return;
        }
        const active: Active = {
          turn: next.value.id,
          cancel: yield* Deferred.make<OperatorLogin>(),
          ended: yield* Deferred.make<Turn>(),
        };
        yield* SynchronizedRef.update(workers, (all) =>
          new Map(all).set(id, { pending: false, active: Option.some(active) }),
        );
        const end = yield* runTurn(record.value, next.value, active);
        yield* Deferred.succeed(active.ended, end);
        yield* SynchronizedRef.update(workers, (all) =>
          new Map(all).set(id, { pending: all.get(id)?.pending ?? false, active: Option.none() }),
        );
      }
    });

    /** Starts the conversation's worker, or tells its running worker to look again. */
    const wake = (id: ConversationId) =>
      SynchronizedRef.updateEffect(workers, (all) => {
        const worker = all.get(id);
        if (worker !== undefined)
          return Effect.succeed(new Map(all).set(id, { ...worker, pending: true }));
        return drain(id).pipe(
          Effect.onError((cause) =>
            Effect.andThen(
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("Conversation worker stopped", { conversation: id, cause }),
              SynchronizedRef.update(workers, (current) => {
                const copy = new Map(current);
                copy.delete(id);
                return copy;
              }),
            ),
          ),
          Effect.forkIn(scope),
          Effect.as(new Map(all).set(id, { pending: false, active: Option.none() })),
        );
      });

    const recover = Effect.gen(function* () {
      const open = yield* store.open;
      const interrupted = open.filter(isRunning);
      for (const turn of interrupted) {
        const usage = yield* storedUsage(store, turn);
        const at = yield* now;
        yield* store.transition(turn, failTurn(turn, at, Interrupted.make({}), usage));
        yield* Effect.logWarning("Supervisor turn interrupted by a restart", {
          conversation: turn.conversation,
          turn: turn.id,
        });
      }
      const waiting = new Set(open.map(({ conversation }) => conversation));
      for (const conversation of waiting) yield* wake(conversation);
      yield* Effect.logInfo("Conversations recovered", {
        interrupted: interrupted.length,
        conversations: waiting.size,
      });
    }).pipe(
      Effect.catchTags({
        ConversationStoreError: ({ operation }) =>
          Effect.logError("Conversations not recovered; the next start retries", { operation }),
        TurnConflict: ({ turn }) =>
          Effect.logError("Conversations not recovered: a turn changed during recovery", {
            turn,
          }),
      }),
      Effect.withSpan("Conversations.recover"),
    );
    yield* recover;

    const cancelRunning = Effect.fn("Conversations.cancelRunning")(function* (
      id: ConversationId,
      turnId: TurnId,
      by: OperatorLogin,
    ) {
      const worker = (yield* SynchronizedRef.get(workers)).get(id);
      const active = Option.filter(
        Option.flatMap(Option.fromUndefinedOr(worker), ({ active }) => active),
        ({ turn }) => turn === turnId,
      );
      if (Option.isSome(active)) {
        yield* Deferred.succeed(active.value.cancel, by);
        return yield* Deferred.await(active.value.ended);
      }
      const current = yield* readable(id);
      const latest = current.turns.find(({ id: candidate }) => candidate === turnId);
      if (latest === undefined || isOpen(latest))
        return yield* Effect.die(new Error(`Turn ${turnId} is open, but no worker runs it`));
      return latest;
    });

    return Conversations.of({
      status,
      list: Effect.fn("Conversations.list")(function* (key, reader) {
        const grants = yield* RequestPermissions;
        const all = yield* store.list(key, reader);
        return all
          .filter(({ conversation }) => permits(grants, "read", conversation.scope))
          .map((summary) => ({ summary, at: DateTime.toEpochMillis(lastActivity(summary)) }))
          .sort((left, right) => right.at - left.at)
          .map(({ summary }) => summary);
      }),
      markRead: Effect.fn("Conversations.markRead")(function* (id, through, member) {
        yield* Effect.annotateCurrentSpan({ conversation: id, through });
        const record = yield* readable(id);
        const last = record.messages.at(-1)?.sequence ?? through;
        const at = yield* now;
        return yield* store.markRead(
          ReadMarker.make({
            conversation: id,
            member,
            through: MessageSequence.make(Math.min(through, last)),
            at,
          }),
        );
      }),
      start: Effect.fn("Conversations.start")(function* (request, { member, credential }) {
        yield* Effect.annotateCurrentSpan({ member: member.login });
        const grants = yield* RequestPermissions;
        if (!permits(grants, "operate", request.scope)) {
          yield* Effect.logWarning("Conversation start refused", { member: member.login });
          return yield* AccessDenied.make({ permission: "operate" });
        }
        if (request.scope._tag === "Project") {
          const project = request.scope.project;
          const { config } = yield* instances.get;
          if (!config.projects.some(({ id }) => id === project))
            return yield* UnknownProject.make({ message: `Project ${project} doesn't exist.` });
        }
        yield* requireReady;
        const anchor = yield* Effect.transposeOption(
          Option.map(request.anchor, ({ kind, reference }) => anchorOf(kind, reference)),
        ).pipe(Effect.provideService(Crypto.Crypto, crypto));
        const at = yield* now;
        const text = yield* bodyText(request.message.body);
        const newConversation = yield* newId;
        const conversationId = ConversationId.make(newConversation);
        const firstTurn = yield* newId;
        const turnId = TurnId.make(firstTurn);
        const conversation = Conversation.make({
          id: conversationId,
          title: Option.getOrElse(request.title, () => titleOf(text)),
          scope: request.scope,
          anchor,
          createdBy: member.login,
          createdAt: at,
        });
        const record = yield* store.create(
          conversation,
          MemberPost.make({
            conversation: conversationId,
            turn: turnId,
            member,
            credential,
            ...request.message,
            at,
          }),
        );
        yield* notify(conversation);
        yield* Effect.logInfo("Conversation started", {
          conversation: conversationId,
          member: member.login,
          anchored: Option.isSome(anchor),
        });
        yield* wake(conversationId);
        return record;
      }),
      read: Effect.fn("Conversations.read")(function* (id) {
        yield* Effect.annotateCurrentSpan({ conversation: id });
        return yield* readable(id);
      }),
      events: Effect.fn("Conversations.events")(function* (id, after, limit) {
        yield* Effect.annotateCurrentSpan({ conversation: id, after });
        yield* readable(id);
        return yield* store.events(id, after, limit);
      }),
      post: Effect.fn("Conversations.post")(function* (id, message, { member, credential }) {
        yield* Effect.annotateCurrentSpan({ conversation: id, member: member.login });
        const record = yield* readable(id);
        yield* requireOn("operate", record.conversation);
        yield* requireReady;
        const newTurn = yield* newId;
        const turnId = TurnId.make(newTurn);
        const at = yield* now;
        const posted = yield* store.post(
          MemberPost.make({
            conversation: id,
            turn: turnId,
            member,
            credential,
            ...message,
            at,
          }),
        );
        yield* notify(record.conversation);
        yield* Effect.logInfo("Member message posted", {
          conversation: id,
          turn: turnId,
          queuedBehind: record.turns.filter(isOpen).length,
        });
        yield* wake(id);
        return posted;
      }),
      cancel: Effect.fn("Conversations.cancel")(function* (id, turnId, by) {
        yield* Effect.annotateCurrentSpan({ conversation: id, turn: turnId });
        const record = yield* readable(id);
        yield* requireOn("operate", record.conversation);
        const turn = record.turns.find(({ id: candidate }) => candidate === turnId);
        if (turn === undefined) return yield* TurnNotFound.make({ conversation: id, turn: turnId });
        if (!isQueued(turn)) return isRunning(turn) ? yield* cancelRunning(id, turnId, by) : turn;
        const at = yield* now;
        const canceled = cancelTurn(turn, at, by, Option.none());
        // The worker can start the turn between the read and this write.
        const stored = yield* store.transition(turn, canceled).pipe(
          Effect.as(true),
          Effect.catchTag("TurnConflict", () => Effect.succeed(false)),
        );
        if (!stored) return yield* cancelRunning(id, turnId, by);
        yield* notify(record.conversation);
        yield* Effect.logInfo("Queued supervisor turn canceled", {
          conversation: id,
          turn: turnId,
          by,
        });
        return canceled;
      }),
    });
  }),
);
