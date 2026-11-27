import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  type AgentSession,
  HarnessSession,
  HarnessSessionId,
  type OperatorMessageId,
  SessionStarted,
} from "@usine/core/agent/session";
import {
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { isRemoteHost } from "../../child-host/child-host.ts";
import { ChildProcessLost } from "../../child-host/process.ts";
import {
  AgentResultError,
  type AgentSessionError,
  ChildBackend,
  ChildSessionLifecycle,
  type InterruptedTool,
  type RunningSession,
  SessionOperationError,
} from "../../runtime.ts";
import { parentFields, resolvedSession, startPrompt, startReference } from "../adapter.ts";
import { CompletionError, CompletionRefused, type SessionSpec, type Start } from "../contract.ts";
import {
  checkContinuationHome,
  childContinuation,
  type ContinuationPolicy,
} from "../continuation.ts";
import { type MessageTaken, sessionConversation } from "../conversation/conversation.ts";
import { HarnessCatalog } from "../harness.ts";
import { apiKeys } from "../pool.ts";
import { type HarnessRuntime, openWithTools } from "../runtime.ts";
import { sessionChannel } from "../session.ts";
import type { HostToolSet } from "../tools.ts";
import { openCodeApi } from "./api.ts";
import {
  ActiveSessions,
  decodeEvent,
  openCodeMessageId,
  openCodeReceipts,
  PostedInput,
  SessionInfo,
} from "./codec.ts";
import {
  baseUrl,
  dataDirectory,
  serveConfig,
  serveEnvironment,
  sessionPermissions,
} from "./config.ts";
import {
  type OpenCodeContext,
  type OpenCodeState,
  type OperatorIds,
  updatePending,
} from "./context.ts";
import { opencode } from "./descriptor.ts";
import { doneCheck } from "./done.ts";
import { openCodeEvents } from "./events.ts";
import { checkModel } from "./model.ts";
import { openCodePreflight } from "./preflight.ts";
import { type RestoredInput, restoredInput } from "./restored.ts";
import { OpenCodeServer } from "./server.ts";
import {
  answered,
  droppedInputs,
  emptyPending,
  enqueued,
  Execution,
  failed,
  inputPosted,
  type InterruptIntent,
  interruptAnswered,
  interruptRefused,
  lateInputsDropped,
  type Pending,
  removed,
  requestInterrupt,
  restarted,
  trackInput,
} from "./state.ts";

export { openCodeServerLive } from "./server.ts";

const makeOpenCodeSessions = Effect.gen(function* () {
  const server = yield* OpenCodeServer;

  const open = Effect.fn("OpenCodeRuntime.open")(function* (
    spec: SessionSpec,
    start: Start,
    policy: ContinuationPolicy,
    hostTools: HostToolSet,
  ) {
    yield* Effect.annotateCurrentSpan({
      agent: spec.session.agent,
      effort: spec.session.brain.effort,
      harness: spec.session.brain.harness,
      model: spec.session.brain.model,
      ...parentFields(spec.session),
      sessionId: spec.session.id,
    });
    const sessionId = spec.session.id;
    if (hostTools.tools.length > 0)
      return yield* AgentResultError.make({
        sessionId: Option.some(sessionId),
        message: "The OpenCode adapter serves no usine tools",
      });
    yield* Effect.logInfo("Launching OpenCode child session", { resume: start._tag });
    const lifecycle = yield* ChildSessionLifecycle.current;
    const reference = startReference(start);
    const data = Option.match(
      Option.flatMap(reference, ({ home }) => home),
      {
        onNone: () => dataDirectory(spec.environment, spec.cwd, sessionId),
        onSome: (home) => home,
      },
    );
    yield* checkContinuationHome(spec, start, Option.some(data), Option.some(data));
    const config = yield* serveConfig({
      brain: spec.session.brain,
      route: spec.admitted.context.credential,
      cwd: spec.cwd,
      baseUrl: baseUrl(spec.environment),
    });
    const target = {
      host: spec.host,
      cwd: spec.cwd,
      environment: serveEnvironment(spec.environment, data, config),
      sessionId: Option.some(sessionId),
    };
    const connection = yield* server.open({
      ...target,
      transport: Option.isSome(reference) ? "resume" : undefined,
    });
    const api = openCodeApi(connection, Option.some(sessionId));
    const model = yield* checkModel(api, spec.session.brain, Option.some(spec.cwd));
    const info = yield* Option.match(reference, {
      onNone: () =>
        api.read(SessionInfo, "launch", "POST", "/api/session", {
          title: `usine ${spec.session.agent}`,
          location: { directory: spec.cwd },
          model,
          permissions: sessionPermissions(spec.admitted.role.nativeTools).map((rule) => ({
            ...rule,
          })),
        }),
      onSome: (saved) =>
        api.read(SessionInfo, "launch", "GET", `/api/session/${encodeURIComponent(saved.id)}`),
    });
    const id = info.data.id;
    const sessionPath = `/api/session/${encodeURIComponent(id)}`;
    yield* api.setToolEnvironment("launch", id);
    const session: AgentSession = resolvedSession(spec.session, {
      brain: BrainSpec.make({
        harness: Harness.make("opencode"),
        model: ModelId.make(model.id),
        effort: spec.session.brain.effort,
      }),
      // OpenCode bills only API keys; a gateway that hasn't reported its kind holds one too.
      pool: Option.some(Option.getOrElse(spec.admitted.pool, () => apiKeys.id)),
      endpoint: Option.none(),
    });
    const channel = yield* sessionChannel({ label: "OpenCode child session", sessionId });
    const harnessSession = HarnessSession.make({
      id: HarnessSessionId.make(id),
      cwd: spec.cwd,
      home: Option.some(data),
    });
    yield* policy.journal.started(harnessSession);
    yield* channel.emit(
      SessionStarted.make({ session, harnessSession: Option.some(harnessSession) }),
    );
    yield* Effect.logInfo("OpenCode child session saved", {
      sessionId,
      harnessSessionId: id,
      cwd: spec.cwd,
      home: data,
      retained: connection.retained,
    });
    // A retained bridge may be in an execution, which then continues.
    const active = connection.retained
      ? yield* api
          .read(ActiveSessions, "launch", "GET", "/api/session/active")
          .pipe(Effect.map(({ data: running }) => Object.hasOwn(running, id)))
      : false;
    // A retained bridge kept what OpenCode delivered and queued, but events and posts may be lost.
    const restoredInputs: RestoredInput = connection.retained
      ? yield* restoredInput(api, id, sessionId, policy.restored.unread)
      : { delivered: [], queued: [], lost: policy.restored.unread };
    // `recover` sends lost messages to an idle session; a running one gets them at once.
    const resent = active && !policy.restored.paused ? restoredInputs.lost : [];

    const operatorIds = yield* Ref.make<OperatorIds>(
      new Map(
        policy.restored.unread.map(({ id: messageId }) => [
          openCodeMessageId(sessionId, messageId),
          messageId,
        ]),
      ),
    );
    const state = yield* Ref.make<OpenCodeState>({
      connection,
      api,
      execution: active ? Execution.Running() : Execution.Idle(),
      pending: restoredInputs.queued.reduce(
        (pending, messageId) => enqueued(pending, openCodeMessageId(sessionId, messageId)),
        emptyPending,
      ),
      toolNames: new Map(),
      toolsInFlight: new Map(),
      lastText: Option.none(),
      retries: 0,
      retrying: false,
      answered: false,
      workReported: false,
      usage: new Map(),
    });
    const current = Effect.map(Ref.get(state), ({ api: currentApi }) => currentApi);
    /** The work that runs outside the operation or event that started it. */
    const tasks = yield* FiberSet.make<void>();

    /**
     * Posts `message` to the session. OpenCode reads it at the running execution's next step
     * boundary, or starts an execution with it, and reports the read with
     * `session.inbox.delivered`. The input counts as unread from before the post until then.
     */
    const post: (
      message: string,
      messageId: Option.Option<OperatorMessageId>,
    ) => Effect.Effect<MessageTaken, AgentSessionError> = Effect.fn("OpenCodeRuntime.post")(
      function* (message: string, messageId: Option.Option<OperatorMessageId>) {
        yield* Effect.annotateCurrentSpan({ sessionId });
        const openCodeId = Option.map(messageId, (operator) =>
          openCodeMessageId(sessionId, operator),
        );
        if (Option.isSome(openCodeId) && Option.isSome(messageId))
          yield* Ref.update(operatorIds, (ids) =>
            new Map(ids).set(openCodeId.value, messageId.value),
          );
        const { key, late } = yield* Ref.modify(state, (latest) => {
          const [posted, pending] = trackInput(latest.pending, openCodeId);
          const [isLate, execution] = inputPosted(latest.execution, posted);
          return [
            { key: posted, late: isLate },
            { ...latest, pending, execution },
          ];
        });
        if (late)
          yield* Effect.logInfo("Posting a steer after the interrupt's answer", { sessionId });
        // An interrupted post drops its input too: OpenCode reports one that it got all the same.
        yield* (yield* current)
          .read(PostedInput, "steer", "POST", `${sessionPath}/prompt`, {
            ...Option.match(openCodeId, { onNone: () => ({}), onSome: (value) => ({ id: value }) }),
            text: message,
            delivery: "steer",
          })
          .pipe(
            Effect.onExit((exit) =>
              dropInputs((pending) =>
                Exit.isSuccess(exit)
                  ? answered(pending, key, exit.value.data.id)
                  : failed(pending, key),
              ),
            ),
          );
        return "queued" as const;
      },
    );

    const inputs = yield* Semaphore.make(1);
    const steer = (
      message: string,
      messageId?: OperatorMessageId,
    ): Effect.Effect<MessageTaken, AgentSessionError> =>
      inputs.withPermits(1)(post(message, Option.fromUndefinedOr(messageId)));

    const conversation = yield* sessionConversation({
      session,
      channel,
      policy,
      submitted: [
        ...restoredInputs.delivered,
        ...restoredInputs.queued,
        ...resent.map(({ id: messageId }) => messageId),
      ],
      decode: openCodeReceipts,
      send: (message, _activity, messageId) => steer(message, messageId),
      pause: Effect.suspend(() => pauseExecution),
      beforeFinish: Effect.flatMap(Ref.get(state), (latest) => latest.connection.close),
      maxBackgroundWaitMinutes: spec.maxBackgroundWaitMinutes,
    });

    const fail = Effect.fn("OpenCodeRuntime.fail")(function* (error: AgentSessionError) {
      if (yield* lifecycle.isStopping) return;
      yield* Effect.flatMap(Ref.get(state), (latest) => latest.connection.close);
      yield* channel.fail(error);
    });

    const context: OpenCodeContext = {
      sessionId,
      root: id,
      session,
      state,
      api: current,
      conversation,
      channel,
      tasks,
      fail,
    };
    const done = doneCheck(context);

    /**
     * Ends the turn that `session.execution.interrupted` with `reason` interrupted. `intent` is the
     * runtime's interrupt, if it asked for one. `deferred` is true when the pause's late inputs
     * kept the turn open and OpenCode won't deliver them: the paused execution's answer ends the
     * turn, even though their steer resumed the conversation.
     */
    const endInterrupted: (
      reason: string,
      intent: Option.Option<InterruptIntent>,
      deferred?: boolean,
    ) => Effect.Effect<void, AgentSessionError> = Effect.fn("OpenCodeRuntime.endInterrupted")(
      function* (reason: string, intent: Option.Option<InterruptIntent>, deferred = false) {
        yield* Effect.annotateCurrentSpan({
          sessionId,
          reason,
          intent: Option.getOrUndefined(intent),
          deferred,
        });
        if (reason === "superseded")
          return yield* Effect.logInfo("A successor execution superseded OpenCode's execution", {
            sessionId,
          });
        const { lastText } = yield* Ref.get(state);
        if (!Option.contains(intent, "stop") && (deferred || (yield* conversation.isPaused)))
          return yield* conversation.finish(
            Option.getOrElse(lastText, () => "OpenCode session paused"),
          );
        if ((yield* lifecycle.isStopping) || (yield* conversation.isClosing))
          return yield* Effect.logInfo("OpenCode's execution stopped with its session", {
            sessionId,
            reason,
          });
        return yield* fail(
          AgentResultError.make({
            sessionId: Option.some(sessionId),
            message:
              reason === "user"
                ? "OpenCode child session was interrupted"
                : `OpenCode stopped the child session's execution (${reason})`,
          }),
        );
      },
    );

    /**
     * Applies `update`, which records an answered, failed, or cancelled input, and returns the
     * answer that waited for the inputs that OpenCode won't deliver. Ends a paused execution's
     * turn that no late input keeps open anymore.
     */
    const dropInputs = (update: (pending: Pending) => Pending): Effect.Effect<void> =>
      Effect.gen(function* () {
        const reason = yield* Ref.modify(state, (latest) => {
          const pending = update(latest.pending);
          const [ends, execution] = lateInputsDropped(
            latest.execution,
            droppedInputs(latest.pending, pending),
          );
          return [ends, { ...latest, execution, pending }];
        });
        yield* done.answerIfDue;
        if (Option.isNone(reason)) return;
        yield* Effect.logInfo(
          "OpenCode won't deliver the steer after the interrupt; the interrupted execution ends the turn",
          { sessionId },
        );
        // A failed post runs under the conversation's lock, which ending the turn takes.
        yield* FiberSet.run(
          tasks,
          endInterrupted(reason.value, Option.some("pause"), true).pipe(Effect.catch(fail)),
        );
      });

    /** Asks OpenCode to interrupt the running execution for `intent`. */
    const interruptExecution = Effect.fn("OpenCodeRuntime.interrupt")(function* (
      intent: InterruptIntent,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId, intent });
      if (yield* lifecycle.isStopping) return;
      const { posting, execution } = yield* Ref.modify(state, (latest) => {
        const [shouldPost, next] = requestInterrupt(latest.execution, intent);
        return [
          { posting: shouldPost, execution: next },
          { ...latest, execution: next },
        ];
      });
      if (!posting)
        return yield* Effect.logInfo(
          execution._tag === "Interrupting"
            ? "OpenCode's execution is already being interrupted"
            : "No OpenCode execution runs to interrupt",
          { sessionId, execution: execution._tag },
        );
      yield* (yield* current).send("interrupt", "POST", `${sessionPath}/interrupt`).pipe(
        Effect.tapError(() =>
          Ref.update(state, (latest): OpenCodeState => ({
            ...latest,
            execution: interruptRefused(latest.execution),
          })),
        ),
      );
      yield* Ref.update(state, (latest): OpenCodeState => ({
        ...latest,
        execution: interruptAnswered(latest.execution),
      }));
    });
    /** Pauses the running execution; its `session.execution.interrupted` leaves the session idle. */
    const pauseExecution = interruptExecution("pause");
    /** Stops the running execution; its `session.execution.interrupted` ends the session. */
    const stopExecution = interruptExecution("stop");

    const handle = openCodeEvents(context, {
      done,
      operatorIds,
      dropInputs,
      endInterrupted,
      pause: pauseExecution,
    });

    const consumeEvents = Stream.unwrap(
      Effect.map(Ref.get(state), (latest) => latest.connection.events),
    ).pipe(
      Stream.runForEach((event) => {
        const decoded = decodeEvent(event);
        if (Option.isSome(decoded.event)) return handle(decoded.event.value);
        if (decoded.malformed)
          return Effect.logWarning("Skipping an OpenCode event with an unknown shape", {
            sessionId,
            type: event.type,
          });
        if (event.type.includes("delta")) return Effect.void;
        return Effect.logDebug("Skipping an OpenCode event", { sessionId, type: event.type });
      }),
    );

    /** Resends unread input and reconciles delivery events lost before the session reopened. */
    const recoverInput = Effect.fn("OpenCodeRuntime.recoverInput")(function* (
      message: string,
      messageId?: OperatorMessageId,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId, messageId });
      const taken = yield* steer(message, messageId);
      if (messageId === undefined) return taken;
      const inputId = openCodeMessageId(sessionId, messageId);
      if (!(yield* (yield* current).messageDelivered(id, inputId))) return taken;
      yield* updatePending(state, (pending) => removed(pending, inputId));
      yield* Effect.logInfo("OpenCode already delivered the resent operator message", {
        sessionId,
        messageId,
      });
      return "read" as const;
    });

    /** Reopens the session on a new bridge after the remote process was lost. */
    const restart = Effect.fn("OpenCodeRuntime.restart")(function* (error: AgentSessionError) {
      yield* Effect.annotateCurrentSpan({ sessionId, harnessSessionId: id });
      if (yield* lifecycle.isStopping) return yield* Effect.never;
      if (
        !isRemoteHost(spec.host) ||
        error._tag !== "SessionOperationError" ||
        !Schema.is(ChildProcessLost)(error.cause)
      )
        return yield* error;
      yield* Effect.logWarning("The remote OpenCode bridge stopped; reopening its saved session", {
        sessionId,
        harnessSessionId: id,
      });
      yield* policy.reopen(
        Effect.gen(function* () {
          const reopened = yield* server.open({ ...target, transport: "replace" });
          const reopenedApi = openCodeApi(reopened, Option.some(sessionId));
          yield* reopenedApi.read(SessionInfo, "launch", "GET", sessionPath);
          yield* reopenedApi.setToolEnvironment("launch", id);
          yield* Ref.update(state, (latest): OpenCodeState => ({
            ...latest,
            connection: reopened,
            api: reopenedApi,
            execution: Execution.Idle(),
            pending: restarted(latest.pending),
            answered: false,
            workReported: false,
          }));
        }),
      );
      const { toolsInFlight } = yield* Ref.getAndUpdate(state, (latest) => ({
        ...latest,
        toolsInFlight: new Map(),
        toolNames: new Map(),
      }));
      yield* conversation.processRestarted;
      const interrupted: ReadonlyArray<InterruptedTool> = [...toolsInFlight].map(
        ([callId, tool]) => ({ callId, tool }),
      );
      yield* conversation.recover(interrupted, recoverInput);
    });

    const consume = Effect.gen(function* () {
      for (;;) {
        const consumed = yield* Effect.result(consumeEvents);
        if ((yield* channel.isTerminal) || (yield* conversation.isClosing)) return;
        if (consumed._tag === "Success")
          return yield* fail(
            SessionOperationError.make({
              operation: "stream",
              sessionId: Option.some(sessionId),
              message: "OpenCode's events ended without a result",
              cause: new Error("unexpected end of events"),
            }),
          );
        yield* restart(consumed.failure);
      }
    }).pipe(Effect.catch(fail));
    yield* Effect.forkScoped(consume);
    for (const messageId of restoredInputs.delivered) yield* conversation.observe(messageId);
    for (const message of resent) {
      yield* Effect.logInfo("Resending an operator message that the running session never got", {
        sessionId,
        messageId: message.id,
      });
      yield* steer(message.message, message.id);
    }

    const prompt = startPrompt(start);
    if (Option.isSome(prompt) && !policy.restored.paused && Option.isNone(policy.restored.idle)) {
      yield* conversation.sendOwn(prompt.value, (message) => steer(message));
      yield* policy.journal.prompted.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not record the OpenCode prompt receipt", {
            sessionId,
            message: error.message,
          }),
        ),
      );
    }

    const running = {
      session,
      events: Stream.fromQueue(channel.events),
      interrupt: stopExecution,
      result: Deferred.await(channel.result),
      steer: (message: string) => steer(message).pipe(Effect.asVoid),
      intervene: conversation.intervene,
    } satisfies RunningSession;
    return {
      running,
      active,
      recover: (tools: ReadonlyArray<InterruptedTool>) => conversation.recover(tools, recoverInput),
    };
  });

  const stop = Effect.fn("OpenCodeRuntime.stop")((spec: SessionSpec) =>
    server.stop({
      host: spec.host,
      cwd: spec.cwd,
      environment: spec.environment,
      sessionId: Option.some(spec.session.id),
    }),
  );

  const complete: HarnessRuntime["complete"] = (spec) =>
    Effect.fail(
      CompletionError.make({
        sessionId: spec.session.id,
        reason: CompletionRefused.make({
          sessionId: spec.session.id,
          message: "OpenCode can't constrain an answer to a JSON Schema",
        }),
        usage: Option.none(),
        message: "OpenCode can't constrain an answer to a JSON Schema",
      }),
    );

  return {
    open: openWithTools(open),
    stop,
    complete,
  } satisfies Pick<HarnessRuntime, "open" | "stop" | "complete">;
});

/** Provides `ChildBackend` for children on OpenCode. Requires `OpenCodeServer`. */
export const openCodeChildLayer = Layer.effect(
  ChildBackend,
  Effect.map(makeOpenCodeSessions, (sessions) =>
    childContinuation(HarnessCatalog.make({ descriptors: [opencode] }), sessions),
  ),
);

/** Combines preflight and scoped sessions for registration. */
export const openCodeRuntime = Effect.gen(function* () {
  const sessions = yield* makeOpenCodeSessions;
  const preflight = yield* openCodePreflight;
  return { id: opencode.id, preflight, ...sessions } satisfies HarnessRuntime;
});
