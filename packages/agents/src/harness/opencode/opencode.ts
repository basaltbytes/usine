import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  type AgentSession,
  BackgroundWork,
  HarnessSession,
  HarnessSessionId,
  type OperatorMessageId,
  ProviderAnswered,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { capacityBackoff } from "@usine/core/attempt";
import { Deferred, Effect, FiberSet, Layer, Option, Ref, Schema, Semaphore, Stream } from "effect";
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
import { type MessageTaken, sessionConversation } from "../conversation.ts";
import { HarnessCatalog } from "../harness.ts";
import { apiKeys } from "../pool.ts";
import { type HarnessRuntime, openWithTools } from "../runtime.ts";
import { sessionChannel } from "../session.ts";
import type { HostToolSet } from "../tools.ts";
import { type OpenCodeApi, openCodeApi, query } from "./api.ts";
import {
  ActiveSessions,
  addUsage,
  capacityFailure,
  decodeEvent,
  distantRetry,
  type HandledEvent,
  Inbox,
  type Job,
  Jobs,
  type OpenCodeTokens,
  openCodeMessageId,
  openCodeReceipts,
  PostedInput,
  type SessionEvent,
  SessionInfo,
  type ShellEvent,
  tokenBreakdown,
  totalTokens,
} from "./codec.ts";
import {
  baseUrl,
  dataDirectory,
  serveConfig,
  serveEnvironment,
  sessionPermissions,
} from "./config.ts";
import { opencode } from "./descriptor.ts";
import { checkModel } from "./model.ts";
import { openCodePreflight } from "./preflight.ts";
import { type OpenCodeConnection, OpenCodeServer } from "./server.ts";
import {
  answerDue,
  answered,
  childCreated,
  childRunning,
  emptyPending,
  enqueued,
  Execution,
  executionInterrupted,
  failed,
  inputPosted,
  type InterruptIntent,
  interruptAnswered,
  interruptRefused,
  inTree,
  lateInputFailed,
  type Pending,
  post as postInput,
  removed,
  requestInterrupt,
  restarted,
  runningWork,
  shellEnded,
  shellStarted,
  unread,
} from "./state.ts";

export { openCodeServerLive } from "./server.ts";

/**
 * A retry that OpenCode schedules further ahead than usine's first wait after a capacity refusal
 * ends the session, so the attempt waits for capacity instead of OpenCode.
 */
const RETRY_THRESHOLD = capacityBackoff(1);

/** What an OpenCode session tracks about its bridge, executions, input, and background work. */
interface OpenCodeState {
  /** The bridge connection; a process restart replaces it. */
  readonly connection: OpenCodeConnection;
  readonly api: OpenCodeApi;
  readonly execution: Execution;
  readonly pending: Pending;
  /** Tool names by call ID, from `session.tool.input.started`. */
  readonly toolNames: ReadonlyMap<string, string>;
  /** The tool calls that started and haven't finished, by call ID. */
  readonly toolsInFlight: ReadonlyMap<string, string>;
  /** The text of the latest execution's last text part. */
  readonly lastText: Option.Option<string>;
  readonly retries: number;
  readonly retrying: boolean;
  /** Whether the model answered since the current bridge started. */
  readonly answered: boolean;
  /** The cumulative usage of each session in the session's tree, by OpenCode session ID. */
  readonly usage: ReadonlyMap<string, { readonly cost: number; readonly tokens: OpenCodeTokens }>;
}

/** Operator message IDs by the OpenCode message IDs that the session posted them with. */
type OperatorIds = ReadonlyMap<string, OperatorMessageId>;

const backgroundWork = (job: Job) =>
  BackgroundWork.make({
    id: job.id,
    kind: job.kind === "shell" ? "command" : job.kind === "subagent" ? "agent" : "other",
    description: job.title ?? job.description ?? job.command ?? "",
  });

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
      pending: emptyPending,
      toolNames: new Map(),
      toolsInFlight: new Map(),
      lastText: Option.none(),
      retries: 0,
      retrying: false,
      answered: false,
      usage: new Map(),
    });
    const current = Effect.map(Ref.get(state), ({ api: currentApi }) => currentApi);
    /** The work that runs outside the operation or event that started it. */
    const tasks = yield* FiberSet.make<void>();
    const updatePending = (f: (pending: Pending) => Pending) =>
      Ref.update(state, (latest): OpenCodeState => ({ ...latest, pending: f(latest.pending) }));
    /**
     * Returns how many inputs OpenCode hasn't delivered, of those the session posted and those
     * OpenCode queued, and records that the answer of the execution that just succeeded waits for
     * them when there are any.
     */
    const holdForInput = Ref.modify(state, (latest): readonly [number, OpenCodeState] => {
      const count = unread(latest.pending);
      return count > 0 && latest.execution._tag === "Idle"
        ? [count, { ...latest, execution: Execution.AwaitingInput() }]
        : [count, latest];
    });
    /**
     * Returns the answer that waited for input once none of that input remains, such as after its
     * post failed, outside the operation that dropped it.
     */
    const answerIfDue = Effect.gen(function* () {
      const due = yield* Ref.modify(state, (latest) => {
        const [isDue, execution] = answerDue(latest.execution, latest.pending);
        return [isDue, { ...latest, execution }];
      });
      if (!due) return;
      yield* Effect.logInfo("The input that the answer waited for won't start an execution", {
        sessionId,
      });
      yield* FiberSet.run(
        tasks,
        Effect.suspend(() => executionSucceeded()).pipe(Effect.catch(fail)),
      );
    });

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
          const [posted, pending] = postInput(latest.pending, openCodeId);
          const [isLate, execution] = inputPosted(latest.execution, posted);
          return [
            { key: posted, late: isLate },
            { ...latest, pending, execution },
          ];
        });
        if (late)
          yield* Effect.logInfo("Posting a steer after the interrupt's answer", { sessionId });
        const posted = yield* (yield* current)
          .read(PostedInput, "steer", "POST", `${sessionPath}/prompt`, {
            ...Option.match(openCodeId, { onNone: () => ({}), onSome: (value) => ({ id: value }) }),
            text: message,
            delivery: "steer",
          })
          .pipe(Effect.tapError(() => inputFailed(key)));
        yield* updatePending((pending) => answered(pending, key, posted.data.id));
        yield* answerIfDue;
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
      submitted: connection.retained ? policy.restored.unread.map(({ id: unread }) => unread) : [],
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

    /**
     * Ends the turn that `session.execution.interrupted` with `reason` interrupted. `intent` is the
     * runtime's interrupt, if it asked for one.
     */
    const endInterrupted: (
      reason: string,
      intent: Option.Option<InterruptIntent>,
    ) => Effect.Effect<void, AgentSessionError> = Effect.fn("OpenCodeRuntime.endInterrupted")(
      function* (reason: string, intent: Option.Option<InterruptIntent>) {
        yield* Effect.annotateCurrentSpan({
          sessionId,
          reason,
          intent: Option.getOrUndefined(intent),
        });
        if (reason === "superseded")
          return yield* Effect.logInfo("A successor execution superseded OpenCode's execution", {
            sessionId,
          });
        const { lastText } = yield* Ref.get(state);
        if (!Option.contains(intent, "stop") && (yield* conversation.isPaused))
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
     * Drops input `key`, whose post failed, and ends a paused execution's turn that no late input
     * keeps open anymore.
     */
    const inputFailed = (key: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const reason = yield* Ref.modify(state, (latest) => {
          const [ends, execution] = lateInputFailed(latest.execution, key);
          return [ends, { ...latest, execution, pending: failed(latest.pending, key) }];
        });
        yield* answerIfDue;
        if (Option.isNone(reason)) return;
        yield* Effect.logInfo(
          "The steer after the interrupt failed; the interrupted execution ends the turn",
          { sessionId },
        );
        // The failed post runs under the conversation's lock, which ending the turn takes.
        yield* FiberSet.run(
          tasks,
          endInterrupted(reason.value, Option.some("pause")).pipe(Effect.catch(fail)),
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

    const reportModelOutput = Effect.fn("OpenCodeRuntime.reportModelOutput")(function* () {
      const latest = yield* Ref.getAndUpdate(state, (value) => ({
        ...value,
        retrying: false,
        answered: true,
      }));
      if (latest.retrying) {
        yield* Effect.logInfo("OpenCode reached its provider again", {
          sessionId,
          retries: latest.retries,
        });
        yield* channel.emit(
          ProviderRecovered.make({ session, retries: ProviderRetries.make(latest.retries) }),
        );
      }
      if (latest.answered) return;
      yield* Effect.logInfo("OpenCode got its provider's first answer since the bridge started", {
        sessionId,
      });
      yield* channel.emit(ProviderAnswered.make({ session }));
    });

    /** Returns the latest answer unless the session has input that OpenCode hasn't delivered. */
    const finishAnswer = Effect.flatMap(Ref.get(state), ({ lastText }) =>
      conversation.finishUnlessUnread(
        Option.getOrElse(lastText, () => "OpenCode finished without an answer"),
        holdForInput,
      ),
    );

    /**
     * Returns the session's answer once nothing starts another execution: no input that OpenCode
     * hasn't delivered and no running background work, by the events that the runtime handled, and
     * then by OpenCode's own lists. Running work is reported, and the conversation waits for the
     * execution that its end starts.
     */
    const executionSucceeded = Effect.fn("OpenCodeRuntime.executionSucceeded")(function* () {
      yield* Effect.annotateCurrentSpan({ sessionId });
      const unreadCount = yield* holdForInput;
      if (unreadCount > 0)
        return yield* Effect.logInfo(
          "OpenCode's execution ended with input that it hasn't delivered, which starts the next execution",
          { sessionId, unread: unreadCount },
        );
      const running = runningWork((yield* Ref.get(state)).pending);
      if (running.length > 0) {
        yield* conversation.reportBackground(Option.some(running));
        return yield* finishAnswer;
      }
      // Work that ended just before the execution may not have queued its notice yet. OpenCode
      // queues the notice before it ends the job, so the job list, then the inbox, then the active
      // executions show the work, its notice, or the execution that the notice started.
      const latestApi = yield* current;
      const jobs = yield* latestApi.read(
        Jobs,
        "stream",
        "GET",
        `/api/experimental/job?${query("sessionID", id)}&descendants=true&status=running`,
      );
      if (jobs.data.length > 0) {
        yield* conversation.reportBackground(Option.some(jobs.data.map(backgroundWork)));
        return yield* finishAnswer;
      }
      const inbox = yield* latestApi.read(Inbox, "stream", "GET", `${sessionPath}/inbox`);
      if (inbox.data.length > 0)
        return yield* Effect.logInfo(
          "OpenCode's execution ended with unread input, which starts the next execution",
          { sessionId, unread: inbox.data.length },
        );
      const { data: activeSessions } = yield* latestApi.read(
        ActiveSessions,
        "stream",
        "GET",
        "/api/session/active",
      );
      if (Object.hasOwn(activeSessions, id))
        return yield* Effect.logInfo("OpenCode started the session's next execution", {
          sessionId,
        });
      yield* conversation.reportBackground(Option.some([]));
      yield* finishAnswer;
    });

    /** Sets the command environment of child session `child`, so its tool commands get the worker's. */
    const childEnvironment = (child: string) =>
      Effect.flatMap(current, (latestApi) => latestApi.setToolEnvironment("stream", child)).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "Could not set the command environment of an OpenCode child session; its commands get OpenCode's directories",
            { sessionId, childSessionId: child, message: error.message },
          ),
        ),
      );

    /** Handles an event of a shell, which counts as background work while it runs. */
    const handleShell = (event: ShellEvent) =>
      event.type === "shell.created"
        ? updatePending((pending) =>
            Option.match(Option.fromUndefinedOr(event.data.info.metadata.sessionID), {
              onNone: () => pending,
              onSome: (session) =>
                shellStarted(pending, id, {
                  id: event.data.info.id,
                  command: event.data.info.command,
                  session,
                }),
            }),
          )
        : updatePending((pending) => shellEnded(pending, event.data.id));

    /** Handles an event of a child session: its creation, executions, and usage. */
    const handleChild = Effect.fn("OpenCodeRuntime.handleChild")(function* (event: SessionEvent) {
      const child = event.data.sessionID;
      switch (event.type) {
        case "session.created": {
          const { parentID, title } = event.data;
          if (parentID === undefined) return;
          const created = yield* Ref.modify(state, (latest) =>
            Option.match(
              childCreated(latest.pending, id, { id: child, parent: parentID, title: title ?? "" }),
              {
                onNone: () => [false, latest],
                onSome: (pending) => [true, { ...latest, pending }],
              },
            ),
          );
          if (!created) return;
          yield* Effect.logInfo("OpenCode started a child session", {
            sessionId,
            childSessionId: child,
          });
          return yield* FiberSet.run(tasks, childEnvironment(child)).pipe(Effect.asVoid);
        }
        case "session.execution.started":
          return yield* updatePending((pending) => childRunning(pending, child, true));
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          return yield* updatePending((pending) => childRunning(pending, child, false));
        default:
          return;
      }
    });

    /** Records the usage of `owner`, a session of the tree, and reports the tree's total. */
    const reportUsage = Effect.fn("OpenCodeRuntime.reportUsage")(function* (
      owner: string,
      cost: number,
      tokens: OpenCodeTokens,
    ) {
      const { usage } = yield* Ref.updateAndGet(state, (latest) => ({
        ...latest,
        usage: new Map(latest.usage).set(owner, { cost, tokens }),
      }));
      const total = addUsage([...usage.values()]);
      yield* channel.emit(
        SessionTokensUpdated.make({
          session,
          totalTokens: totalTokens(total.tokens),
          costUsd: Option.some(total.cost),
          breakdown: Option.some(tokenBreakdown(total.tokens)),
        }),
      );
    });

    const handle = Effect.fn("OpenCodeRuntime.handle")(function* (event: HandledEvent) {
      if (
        event.type === "shell.created" ||
        event.type === "shell.exited" ||
        event.type === "shell.deleted"
      )
        return yield* handleShell(event);
      const { pending } = yield* Ref.get(state);
      if (!inTree(pending, id, event.data.sessionID) && event.type !== "session.created") return;
      if (event.type === "session.usage.updated")
        return yield* reportUsage(event.data.sessionID, event.data.cost, event.data.tokens);
      if (event.data.sessionID !== id) return yield* handleChild(event);
      switch (event.type) {
        case "session.execution.started": {
          const { execution } = yield* Ref.getAndUpdate(state, (latest): OpenCodeState => ({
            ...latest,
            execution: Execution.Running(),
            lastText: Option.none(),
            retries: 0,
            retrying: false,
          }));
          if (execution._tag === "AwaitingSuccessor")
            yield* Effect.logInfo(
              "A successor execution reads the steer after the interrupt and ends the turn",
              { sessionId },
            );
          return yield* conversation.turnStarted;
        }
        case "session.inbox.enqueued":
          return yield* updatePending((latest) => enqueued(latest, event.data.inboxID));
        case "session.inbox.cancelled":
          yield* Effect.logInfo("OpenCode cancelled an input that the session hadn't read", {
            sessionId,
            inboxId: event.data.inboxID,
          });
          yield* updatePending((latest) => removed(latest, event.data.inboxID));
          return yield* answerIfDue;
        case "session.inbox.delivered": {
          const operator = (yield* Ref.get(operatorIds)).get(event.data.inboxID);
          yield* updatePending((latest) => removed(latest, event.data.inboxID));
          if (operator === undefined) return;
          yield* conversation.observe(operator);
          return;
        }
        case "session.text.ended": {
          const text = event.data.text.trim();
          if (text.length === 0) return;
          yield* Ref.update(state, (latest) => ({ ...latest, lastText: Option.some(text) }));
          return yield* channel.emit(TextOutput.make({ session, text }));
        }
        case "session.tool.input.started": {
          const { id: callId, name } = event.data;
          return yield* Ref.update(state, (latest) => ({
            ...latest,
            toolNames: new Map(latest.toolNames).set(callId, name),
          }));
        }
        case "session.tool.called": {
          const callId = event.data.id;
          const tool = (yield* Ref.get(state)).toolNames.get(callId) ?? "unknown";
          yield* Ref.update(state, (latest) => ({
            ...latest,
            toolsInFlight: new Map(latest.toolsInFlight).set(callId, tool),
          }));
          return yield* channel.emit(
            ToolStarted.make({ session, callId, tool, input: event.data.input }),
          );
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const callId = event.data.id;
          const tool = yield* Ref.modify(state, (latest) => {
            const toolsInFlight = new Map(latest.toolsInFlight);
            const name = toolsInFlight.get(callId) ?? latest.toolNames.get(callId) ?? "unknown";
            toolsInFlight.delete(callId);
            const toolNames = new Map(latest.toolNames);
            toolNames.delete(callId);
            return [name, { ...latest, toolsInFlight, toolNames }];
          });
          return yield* channel.emit(
            ToolFinished.make({
              session,
              callId,
              tool,
              output:
                event.type === "session.tool.success"
                  ? event.data.content
                  : { type: event.data.error.type, message: event.data.error.message },
              isError: event.type === "session.tool.failed",
            }),
          );
        }
        case "session.step.ended":
          return yield* reportModelOutput();
        case "session.retry.scheduled": {
          const capacity = distantRetry(sessionId, event.data, RETRY_THRESHOLD);
          if (Option.isSome(capacity)) {
            yield* Effect.logWarning(
              "OpenCode's provider retry is too far ahead; ending the session",
              {
                sessionId,
                retryAfterMs: event.data.error.retryAfterMs,
                type: event.data.error.type,
              },
            );
            return yield* fail(capacity.value);
          }
          const retries = yield* Ref.modify(state, (latest) => [
            latest.retries + 1,
            { ...latest, retries: latest.retries + 1, retrying: true },
          ]);
          yield* Effect.logWarning("OpenCode can't reach its provider and will retry", {
            sessionId,
            retries,
            attempt: event.data.attempt,
            retryAfterMs: event.data.error.retryAfterMs,
            type: event.data.error.type,
          });
          return yield* channel.emit(
            ProviderRetrying.make({
              session,
              message: event.data.error.message || event.data.error.type,
              retries: ProviderRetries.make(retries),
            }),
          );
        }
        case "session.execution.succeeded":
          yield* Ref.update(state, (latest): OpenCodeState => ({
            ...latest,
            execution: Execution.Idle(),
          }));
          return yield* executionSucceeded();
        case "session.execution.failed": {
          yield* Ref.update(state, (latest): OpenCodeState => ({
            ...latest,
            execution: Execution.Idle(),
          }));
          const { error } = event.data;
          yield* Effect.logWarning("OpenCode's execution failed", {
            sessionId,
            type: error.type,
            message: error.message,
          });
          return yield* fail(
            Option.getOrElse(capacityFailure(sessionId, error), () =>
              AgentResultError.make({
                sessionId: Option.some(sessionId),
                message: `OpenCode's execution failed (${error.type}): ${error.message}`,
              }),
            ),
          );
        }
        case "session.execution.interrupted": {
          const { reason } = event.data;
          const outcome = yield* Ref.modify(state, (latest) => {
            const [ended, execution] = executionInterrupted(
              latest.execution,
              reason,
              latest.pending,
            );
            return [ended, { ...latest, execution }];
          });
          if (outcome._tag === "Deferred")
            return yield* Effect.logInfo(
              "A steer posted after the interrupt keeps the turn open for its successor execution",
              { sessionId, undelivered: outcome.late.length },
            );
          return yield* endInterrupted(reason, outcome.intent);
        }
        case "session.created":
          return;
      }
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

    /** Sends the input of a continuation after a restart. */
    const recoverInput = (message: string, messageId?: OperatorMessageId) =>
      steer(message, messageId);

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
