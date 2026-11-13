import type { OperatorMessageId } from "@usine/core/attempt/channel";
import {
  childContinuation,
  checkContinuationHome,
  type ContinuationPolicy,
  environmentHome,
} from "../continuation.ts";
import { type SessionSpec, type Start } from "../contract.ts";
import { parentFields, resolvedSession, startPrompt, startReference } from "../adapter.ts";
import { HarnessCatalog } from "../harness.ts";
import { claudePreflight } from "./preflight.ts";
import { claude } from "./descriptor.ts";
import { type HarnessRuntime, openWithTools } from "../runtime.ts";
import { callHostTool, type HostToolSet, hostToolNames } from "../tools.ts";
// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { Harness, ModelId } from "@usine/core/agent/brain";
import {
  type BillingPool,
  HarnessSession,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  SessionStarted,
  SessionTokensUpdated,
} from "@usine/core/agent/session";
import {
  type Cause,
  Crypto,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FiberSet,
  Layer,
  Option,
  Queue,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  HostLoginLock,
  ChildBackend,
  ChildSessionLifecycle,
  type InterruptedTool,
  ChildSessionJournal,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
} from "../../runtime.ts";
import { isRemoteHost } from "../../child-host/child-host.ts";
import { ChildProcessLost, stopChildProcess } from "../../child-host/process.ts";
import { sdkProcessSpawner } from "../../child-host/sdk.ts";
import { sessionChannel } from "../session.ts";
import { sessionConversation } from "../conversation.ts";
import { claudeSessionMeter, claudeTokenMeter } from "../usage.ts";
import { structuredCompletion } from "../completion.ts";
import { claudeCompletion } from "./completion.ts";
import { brainOptions } from "./options.ts";
import { claudeRateLimits } from "./rate-limits.ts";
import { claudeProviderFailures } from "./provider.ts";
import {
  apiRetryMessage,
  ClaudeApiRetry,
  ClaudeCompletionHeader,
  ClaudeResultMessage,
  decodeMessageAcknowledgement,
  decodeCompletionUpdate,
  isAssistantMessage,
  loginCheck,
  type LoginCheck,
  sessionEventsFrom,
} from "./codec.ts";
import {
  AsyncInput,
  ClaudeSdk,
  claudeOutputCheckpoint,
  type ClaudeModelInfo,
  type ClaudeQuery,
  type ClaudeQueryOptions,
  type ClaudeTool,
  type ClaudeToolServer,
  type ClaudeUserMessage,
  userMessage,
} from "./sdk.ts";

export {
  ClaudeSdk,
  claudeSdkLive,
  type ClaudeModelInfo,
  type ClaudeQuery,
  type ClaudeQueryOptions,
  type ClaudeTool,
  type ClaudeToolServer,
  type ClaudeUserMessage,
} from "./sdk.ts";

const operationError = (
  operation: SessionOperationError["operation"],
  spec: SessionSpec,
  message: string,
  cause: unknown,
): SessionOperationError =>
  SessionOperationError.make({
    operation,
    sessionId: Option.some(spec.session.id),
    message,
    cause,
  });

/** The MCP server that serves a session's usine tools. */
const TOOL_SERVER = "usine";
/** The prefix that Claude Code gives the tools of `TOOL_SERVER`. */
const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`;
/** The API takes tool names of at most 64 characters, and Claude Code adds the server prefix. */
const toolNameRule = { maxLength: 64 - TOOL_PREFIX.length, reserved: new Set<string>() };

/**
 * Returns the SDK options; each launch supplies the shared process callback. A role that closes
 * native tools gets no built-in tool and no MCP server beyond its usine tools.
 */
const optionsFor = (spec: SessionSpec, start: Start, sessionId: string): ClaudeQueryOptions => {
  const options: ClaudeQueryOptions = {
    ...brainOptions(spec),
    allowDangerouslySkipPermissions: true,
    permissionMode: "bypassPermissions",
    persistSession: true,
    ...Option.match(startReference(start), {
      onNone: () => ({ sessionId }),
      onSome: (saved) => ({ resume: saved.id }),
    }),
    // Flag settings take precedence over the Worker user's settings file.
    settings: { attribution: { commit: "", pr: "" } },
  };
  return spec.admitted.role.nativeTools
    ? options
    : { ...options, tools: [], strictMcpConfig: true };
};

const modelExists = (models: ReadonlyArray<ClaudeModelInfo>, model: ModelId): boolean =>
  models.some((candidate) => candidate.value === model || candidate.resolvedModel === model);

/**
 * The delays before each relaunch after a Claude process loses the login refresh lock; Claude's
 * error says to retry in a minute. If the last launch fails the same way, the parent gets the error
 * (#453).
 */
const LOGIN_RETRY_DELAYS: ReadonlyArray<Duration.Duration> = [
  Duration.seconds(15),
  Duration.seconds(30),
  Duration.seconds(60),
];

/**
 * The maximum time a launch keeps its Claude login lock while waiting for a message that decides
 * the login state. If no such message arrives, the launch continues as a started session.
 */
const LOGIN_WINDOW = Duration.seconds(60);

/**
 * The maximum time an idle Claude child that has answered waits for its background work and the
 * notification turn that follows it. When the limit passes, the child returns the saved answer.
 * The limit is kept in memory, so a child reattached after an orchestrator restart has none.
 */
const BACKGROUND_WAIT_LIMIT = Duration.minutes(2);

/** One Claude Code launch for a child. */
interface ClaudeLaunch {
  readonly input: AsyncInput;
  readonly query: ClaudeQuery;
  /** The messages read by the login check, in order; later messages are in `output`. */
  readonly read: ReadonlyArray<Schema.Json>;
  readonly output: Queue.Dequeue<Schema.Json, SessionOperationError | Cause.Done>;
  /**
   * The login state shown by `read`; `undecided` if the launch sent no message, the output ended or
   * failed, or nothing decided it in time.
   */
  readonly login: Exclude<LoginCheck, "waiting"> | "undecided";
  readonly retained: boolean;
  /** Checkpoints a handled message. */
  readonly acknowledge: (message: Schema.Json) => Effect.Effect<void>;
  /** Whether the checkpoint covers every acknowledged message and the output read before it. */
  readonly covered: Effect.Effect<boolean>;
  /** The scope of the launch's process, input, and output reader. */
  readonly scope: Scope.Closeable;
}

const makeClaudeSessions = Effect.gen(function* () {
  const sdk = yield* ClaudeSdk;
  const logins = yield* HostLoginLock;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;

  /**
   * Acquires the spec's Claude login lock in a fiber of the current scope and returns an effect
   * that releases it. The lock is also released after `LOGIN_WINDOW`, so a hung launch does not
   * block other Claude launches and preflights on that login.
   */
  const holdLogin = Effect.fn("ClaudeRuntime.holdLogin")(function* (spec: SessionSpec) {
    const fields = {
      sessionId: spec.session.id,
      worker: spec.worker,
      ...Option.match(spec.machine, { onNone: () => ({}), onSome: (machine) => ({ machine }) }),
    };
    yield* Effect.annotateCurrentSpan(fields);
    const held = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      logins.withLock(
        Harness.make("claude"),
        spec.worker,
        spec.machine,
      )(
        Deferred.succeed(held, undefined).pipe(
          Effect.andThen(Deferred.await(released)),
          Effect.timeoutOption(LOGIN_WINDOW),
          Effect.flatMap(
            Option.match({
              onSome: () => Effect.void,
              onNone: () =>
                Effect.logWarning(
                  "Claude child showed no sign of its login in time; releasing its Claude login lock",
                  fields,
                ),
            }),
          ),
        ),
      ),
    );
    yield* Deferred.await(held);
    yield* Effect.logDebug("Holding the Claude login lock to launch the child", fields);
    // The caller releases the Claude login lock after launch.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Deferred.succeed(released, undefined).pipe(Effect.asVoid);
  });

  /** Reads messages from `output` into `read` until one decides the login state. */
  const checkLogin = Effect.fn("ClaudeRuntime.checkLogin")(function* (
    output: Queue.Dequeue<Schema.Json, SessionOperationError | Cause.Done>,
    read: Array<Schema.Json>,
  ) {
    const tokens = claudeTokenMeter();
    let spentTokens = false;
    for (;;) {
      const next = yield* Effect.result(Queue.take(output));
      // The session reports a closed or failed output itself.
      if (Result.isFailure(next)) return "undecided" as const;
      read.push(next.success);
      spentTokens ||= Option.exists(
        tokens.read(next.success),
        ({ totalTokens }) => totalTokens > 0,
      );
      const check = loginCheck(next.success, spentTokens);
      if (check !== "waiting") return check;
    }
  });

  /**
   * Launches Claude Code once for `spec` and sends `messages`, keeping its Claude login lock
   * until the first messages decide the login state. With no messages, the launch waits for input
   * and skips the login check. Resources are added to the current scope.
   */
  const launchOnce = Effect.fn("ClaudeRuntime.launchOnce")(function* (
    spec: SessionSpec,
    options: ClaudeQueryOptions,
    tools: Option.Option<ClaudeToolServer>,
    messages: ReadonlyArray<ClaudeUserMessage>,
    transport?: "replace" | "resume",
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: spec.session.id, worker: spec.worker });
    const release = yield* holdLogin(spec);
    const journal = yield* ChildSessionJournal.current;
    return yield* Effect.gen(function* () {
      const input = new AsyncInput();
      const recordPrompt = yield* Effect.cached(
        journal.prompted.pipe(
          Effect.tap(() =>
            Effect.logDebug("The Claude process owner acknowledged the first user message", {
              sessionId: spec.session.id,
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning(
              "Could not record the Claude prompt receipt; a restart sends the task again",
              { sessionId: spec.session.id, message: error.message },
            ),
          ),
        ),
      );
      const checkpoint = yield* claudeOutputCheckpoint(recordPrompt);
      const owner = yield* sdkProcessSpawner(
        {
          host: spec.host,
          cwd: spec.cwd,
          sessionId: Option.some(spec.session.id),
          environment: spec.environment,
        },
        {
          transport,
          readOutput: checkpoint.read,
          onInputAcknowledged: checkpoint.inputAcknowledged,
        },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const query = sdk.open(input, { ...options, spawnClaudeCodeProcess: owner.spawn }, tools);
      const output = yield* Queue.make<Schema.Json, SessionOperationError | Cause.Done>();
      yield* Effect.forkScoped(
        Stream.fromAsyncIterable(query, (cause) =>
          operationError("stream", spec, "Claude output stream failed", cause),
        ).pipe(
          Stream.catch((error) =>
            Stream.unwrap(owner.diagnose(error).pipe(Effect.map(Stream.fail))),
          ),
          Stream.runIntoQueue(output),
        ),
      );
      // Finalizers run newest first, so this closes the query before the scope stops the output
      // reader. Stopping the reader waits for its pending read, and when Claude keeps a session
      // open after a failed turn, only closing the query ends that read.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          input.end();
          query.close();
        }),
      );
      const models = yield* Effect.tryPromise({
        try: () => query.supportedModels(),
        catch: (cause) => operationError("launch", spec, "Claude model discovery failed", cause),
      }).pipe(Effect.catch((error) => owner.diagnose(error).pipe(Effect.flatMap(Effect.fail))));
      if (!modelExists(models, spec.session.brain.model)) {
        yield* Effect.logError("Claude child rejected an unknown model");
        return yield* UnknownModelError.make({
          harness: Harness.make("claude"),
          model: spec.session.brain.model,
          message: `Claude has no model "${spec.session.brain.model}"`,
        });
      }
      const retained = yield* owner.retained;
      if (!retained) for (const message of messages) input.offer(message);
      else
        yield* Effect.logInfo("Reattached the running Claude session", {
          sessionId: spec.session.id,
        });
      const read: Array<Schema.Json> = [];
      const loginResult =
        messages.length === 0 || retained
          ? Option.none()
          : yield* checkLogin(output, read).pipe(Effect.timeoutOption(LOGIN_WINDOW));
      const login = Option.getOrElse(loginResult, () => "undecided" as const);
      yield* Effect.logDebug("Claude child's first messages settled its login check", {
        sessionId: spec.session.id,
        worker: spec.worker,
        login,
        messages: read.length,
      });
      return {
        input,
        query,
        read,
        output,
        login,
        retained,
        acknowledge: (message: Schema.Json) =>
          checkpoint.handled(message).pipe(Effect.flatMap(owner.acknowledge)),
        covered: checkpoint.covered,
      } satisfies Omit<ClaudeLaunch, "scope">;
    }).pipe(Effect.ensuring(release));
  });

  /**
   * Launches Claude Code for `spec`, relaunching after each delay in `LOGIN_RETRY_DELAYS` while it
   * fails on the login refresh lock. Each launch has its own scope inside `scope`, closed before the
   * next or when the launch fails, so a failed launch's process and messages do not reach the
   * session. Returns the launch with its scope.
   */
  const launchWithRetries = Effect.fn("ClaudeRuntime.launchWithRetries")(function* (
    spec: SessionSpec,
    options: ClaudeQueryOptions,
    tools: Option.Option<ClaudeToolServer>,
    messages: ReadonlyArray<ClaudeUserMessage>,
    scope: Scope.Scope,
    transport?: "replace" | "resume",
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: spec.session.id, worker: spec.worker });
    let launchOptions = options;
    for (let retry = 0; ; retry += 1) {
      const launchScope = yield* Scope.fork(scope);
      const opened: ClaudeLaunch = {
        ...(yield* launchOnce(spec, launchOptions, tools, messages, transport).pipe(
          Scope.provide(launchScope),
          Effect.onError((cause) => Scope.close(launchScope, Exit.failCause(cause))),
        )),
        scope: launchScope,
      };
      if (opened.login !== "contended") {
        if (opened.login === "undecided")
          yield* Effect.logInfo("Claude child started without showing whether its login worked", {
            sessionId: spec.session.id,
            worker: spec.worker,
            messages: messages.length,
          });
        return opened;
      }
      const delay = LOGIN_RETRY_DELAYS[retry];
      if (delay === undefined) {
        yield* Effect.logWarning(
          "Claude child still could not refresh its Claude login; returning the error to the parent",
          {
            sessionId: spec.session.id,
            ...parentFields(spec.session),
            worker: spec.worker,
            retries: retry,
          },
        );
        return opened;
      }
      yield* Scope.close(launchScope, Exit.void);
      const { sessionId, ...remaining } = launchOptions;
      if (sessionId !== undefined) launchOptions = { ...remaining, resume: sessionId };
      yield* Effect.logInfo("Claude child could not refresh its Claude login; launching it again", {
        sessionId: spec.session.id,
        ...parentFields(spec.session),
        worker: spec.worker,
        retry: retry + 1,
        maxRetries: LOGIN_RETRY_DELAYS.length,
        delay: Duration.format(delay),
      });
      yield* Effect.sleep(delay);
    }
  });

  /** A route without a gateway credential kind leaves the pool to Claude Code's own account. */
  const billingPool = (spec: SessionSpec, query: ClaudeQuery) =>
    Option.match(spec.admitted.pool, {
      onSome: (pool) => Effect.succeed(pool),
      onNone: () =>
        Effect.tryPromise({
          try: () => query.usesApiKey(),
          catch: (cause) =>
            operationError("launch", spec, "Claude account discovery failed", cause),
        }).pipe(Effect.map((apiKey): BillingPool => (apiKey ? "apiKeys" : "claudePlan"))),
    });

  /** Serves `tools` to a session as the in-process MCP server `TOOL_SERVER`. */
  const serveTools = Effect.fn("ClaudeRuntime.serveTools")(function* (tools: HostToolSet) {
    const names = yield* hostToolNames(tools, toolNameRule);
    const call = callHostTool(tools, names);
    const run = yield* FiberSet.makeRuntimePromise();
    const server: Option.Option<ClaudeToolServer> =
      tools.tools.length > 0
        ? Option.some({
            name: TOOL_SERVER,
            tools: tools.tools.map((tool): ClaudeTool => ({
              name: names.alias(tool.name),
              description: tool.description,
              inputSchema: tool.parameters,
            })),
            call: (name, input, callId, signal) => run(call(name, input, callId), { signal }),
          })
        : Option.none();
    /** The toolkit name of a usine tool, or the name that Claude Code reports for its own. */
    const toolName = (reported: string) =>
      reported.startsWith(TOOL_PREFIX)
        ? Option.getOrElse(names.name(reported.slice(TOOL_PREFIX.length)), () => reported)
        : reported;
    return { server, toolName };
  });

  const open = Effect.fn("ClaudeRuntime.open")(function* (
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
      worker: spec.worker,
    });
    yield* Effect.logInfo("Launching Claude child session", {
      usineTools: hostTools.tools.length,
      nativeTools: spec.admitted.role.nativeTools,
    });
    const { server, toolName } = yield* serveTools(hostTools);
    const context = yield* Effect.context<never>();
    const scope = yield* Effect.scope;
    const boundaryReady = yield* Deferred.make<void>();
    let boundary = Effect.void;
    const pauseAtBoundary: HookCallback = async (_input, _id, options) => {
      await Effect.runPromiseWith(context)(
        Effect.acquireUseRelease(
          Effect.forkIn(
            Deferred.await(boundaryReady).pipe(Effect.andThen(Effect.suspend(() => boundary))),
            scope,
          ),
          Fiber.join,
          Fiber.interrupt,
        ),
        { signal: options.signal },
      );
      return {};
    };
    const { home, defaultHome } = environmentHome(spec.environment, "CLAUDE_CONFIG_DIR", ".claude");
    const reference = Option.getOrElse(startReference(start), () =>
      HarnessSession.make({
        cwd: spec.cwd,
        home,
      }),
    );
    const options: ClaudeQueryOptions = {
      ...optionsFor(spec, start, reference.id),
      hooks: {
        PreToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
        PostToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
      },
    };
    const lifecycle = yield* ChildSessionLifecycle.current;
    const journal = yield* ChildSessionJournal.current;
    yield* checkContinuationHome(spec, start, home, defaultHome);
    yield* journal.started(reference);
    // Login-lock retries finish before the session starts.
    const startsIdle = policy.restored.paused || Option.isSome(policy.restored.idle);
    // Claude names a message with a client UUID on each result that consumed it.
    const clientId = crypto.randomUUIDv4().pipe(Effect.orDie);
    const prompts = startsIdle
      ? []
      : yield* Effect.forEach(Option.toArray(startPrompt(start)), (text) =>
          Effect.map(clientId, (uuid) => userMessage(text, uuid)),
        );
    let current = yield* launchWithRetries(
      spec,
      options,
      server,
      prompts,
      scope,
      start._tag === "StartResume" ? "resume" : undefined,
    );

    const pool = yield* billingPool(spec, current.query);
    const session = resolvedSession(spec.session, {
      brain: spec.session.brain,
      pool: Option.some(pool),
      endpoint: spec.session.endpoint,
    });
    yield* Effect.logInfo("Claude billing pool verified", { sessionId: session.id, pool });
    const channel = yield* sessionChannel({
      label: "Claude child session",
      sessionId: session.id,
    });
    channel.onTerminal(() => {
      current.input.end();
    });
    yield* channel.emit(SessionStarted.make({ session, harnessSession: Option.some(reference) }));
    // A retained process that never acknowledged its task waits for input without a turn.
    const unprompted = current.retained && !policy.restored.prompted;
    if (unprompted)
      yield* Effect.logWarning("The retained Claude process never received its task", {
        sessionId: session.id,
        harnessSessionId: reference.id,
      });
    const submitted =
      current.retained && !unprompted ? policy.restored.unread.map(({ id }) => id) : [];
    /**
     * The tool-call count where each submitted message starts a turn of its own. Claude reads such
     * a message when that turn starts, before its tool calls.
     */
    const queuedTurnStarts = new Map<OperatorMessageId, number>();
    /**
     * Whether Claude runs no turn, from a result until the next assistant message. A message sent
     * then starts the next turn instead of joining a running one.
     */
    let betweenTurns = current.retained ? unprompted || startsIdle : prompts.length === 0;
    const send = Effect.fn("ClaudeRuntime.send")(function* (
      message: string,
      id?: OperatorMessageId,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      const uuid = id ?? (yield* clientId);
      yield* Effect.try({
        try: () => current.input.offer(userMessage(message, uuid)),
        catch: (cause) => operationError("steer", spec, "Can't send a message to Claude", cause),
      });
      if (id === undefined) return;
      submitted.push(id);
      if (!betweenTurns) return;
      const calls = yield* channel.toolCalls;
      queuedTurnStarts.set(id, calls);
      yield* Effect.logInfo("Claude reads the operator message when its next turn starts", {
        sessionId: session.id,
        toolCalls: calls,
      });
    });
    const conversation = yield* sessionConversation({
      session,
      channel,
      held: policy.restored.held,
      paused: policy.restored.paused,
      idle: policy.restored.idle,
      idleAnsweredOperator: policy.restored.idleAnsweredOperator,
      unread: policy.restored.unread,
      submitted,
      // A message sent during a turn is queued until a tool call returns or the turn ends.
      send: (message, _activity, id) => send(message, id).pipe(Effect.as("queued" as const)),
      pause: Effect.void,
      beforeFinish: Effect.void,
    });
    boundary = conversation.awaitUnpaused;
    /** Reports `ids` as read by a result: at their queued turn's start, or where the turn folded them. */
    const readAtResult = (ids: ReadonlyArray<OperatorMessageId>) =>
      Effect.gen(function* () {
        const folded = ids.filter((id) => !queuedTurnStarts.has(id));
        if (folded.length > 0) yield* conversation.read(folded, "turn");
        for (const id of ids) {
          const start = queuedTurnStarts.get(id);
          if (start === undefined) continue;
          queuedTurnStarts.delete(id);
          yield* conversation.read([id], start);
        }
      });
    /**
     * Drops the turn start of each message that the first frame of a turn, which lists `opening`,
     * doesn't name. Claude didn't start the turn with such a message, so it folds it in later.
     */
    const turnOpened = (opening: ReadonlyArray<OperatorMessageId>) =>
      Effect.gen(function* () {
        const later = [...queuedTurnStarts.keys()].filter((id) => !opening.includes(id));
        if (later.length === 0) return;
        for (const id of later) queuedTurnStarts.delete(id);
        yield* Effect.logInfo(
          "Claude started a turn without some sent operator messages; it reads them at a tool result",
          { sessionId: session.id, later: later.length },
        );
      });
    yield* Deferred.succeed(boundaryReady, undefined);
    const tools = new Map<string, string>();
    const usage = claudeSessionMeter(
      Option.getOrUndefined(policy.restored.usage),
      current.retained,
    );
    const readRateLimits = claudeRateLimits(session);
    let backgroundTasks: ReadonlyArray<string> = [];
    // Holds the timer that ends a wait for background work after the child answered.
    const backgroundWait = yield* FiberHandle.make<void>();
    let reportsSessionState = false;
    let completedTurn = Option.none<string>();
    // API retries reported in the current turn, and whether the last retry is unresolved.
    let retries = 0;
    let retrying = false;

    /** Waits for background work after `answer`, then returns `answer` once the limit passes. */
    const awaitBackgroundWork = Effect.fn("ClaudeRuntime.awaitBackgroundWork")(function* (
      answer: string,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      yield* Effect.logInfo("Claude child is waiting for background work", {
        sessionId: session.id,
        backgroundTaskIds: backgroundTasks,
        limit: Duration.format(BACKGROUND_WAIT_LIMIT),
      });
      yield* FiberHandle.run(
        backgroundWait,
        Effect.sleep(BACKGROUND_WAIT_LIMIT).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              Effect.logWarning(
                "Claude child's background work outlasted the wait limit; returning its answer",
                {
                  sessionId: session.id,
                  backgroundTaskIds: backgroundTasks,
                  limit: Duration.format(BACKGROUND_WAIT_LIMIT),
                },
              ),
            ),
          ),
          Effect.andThen(conversation.finish(answer)),
        ),
      );
    });
    /** Cancels the running wait limit, if any, and logs `reason`. */
    const resumeTurn = Effect.fn("ClaudeRuntime.resumeTurn")(function* (
      reason: "turn started" | "process resumed",
    ) {
      const wait = yield* FiberHandle.get(backgroundWait);
      if (Option.isNone(wait)) return;
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      yield* FiberHandle.clear(backgroundWait);
      yield* Effect.logInfo("Claude child cancelled the wait limit for its background work", {
        sessionId: session.id,
        reason,
        backgroundTaskIds: backgroundTasks,
      });
    });

    const reportRetry = Effect.fn("ClaudeRuntime.reportRetry")(function* (
      retry: typeof ClaudeApiRetry.Type,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      retries += 1;
      retrying = true;
      const message = apiRetryMessage(retry);
      yield* Effect.logWarning("Claude child cannot reach its provider and will retry", {
        sessionId: session.id,
        retries,
        message,
        status: retry.error_status,
        error: retry.error,
      });
      yield* channel.emit(
        ProviderRetrying.make({
          session,
          message,
          retries: ProviderRetries.make(retries),
        }),
      );
    });
    const reportRecovery = Effect.fn("ClaudeRuntime.reportRecovery")(function* () {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      retrying = false;
      yield* Effect.logInfo("Claude child reached its provider again", {
        sessionId: session.id,
        retries,
      });
      yield* channel.emit(
        ProviderRecovered.make({
          session,
          retries: ProviderRetries.make(retries),
        }),
      );
    });

    const provider = claudeProviderFailures(session.id);

    /** Applies one message from Claude to the session. */
    const handle = (message: Schema.Json) =>
      Effect.gen(function* () {
        const acknowledged = decodeMessageAcknowledgement(message);
        if (Option.isSome(acknowledged)) {
          const ids = acknowledged.value.user_message_uuids;
          for (let index = submitted.length - 1; index >= 0; index -= 1) {
            const id = submitted[index];
            if (id !== undefined && ids.includes(id)) submitted.splice(index, 1);
          }
          if (Schema.is(ClaudeResultMessage)(message)) yield* readAtResult(ids);
          else {
            if (betweenTurns && isAssistantMessage(message)) yield* turnOpened(ids);
            for (const id of ids) queuedTurnStarts.delete(id);
            yield* conversation.read(ids, "now");
          }
        }
        const limits = yield* readRateLimits(message);
        if (Option.isSome(limits)) yield* channel.emit(limits.value);
        const reported = provider.read(message);
        if (Option.isSome(reported.rejectedUntil))
          yield* Effect.logWarning("Claude reports that its usage limit rejects requests", {
            sessionId: session.id,
            resetsAt: DateTime.formatIso(reported.rejectedUntil.value),
          });
        if (Option.isSome(reported.retry)) return yield* reportRetry(reported.retry.value);
        if (isAssistantMessage(message)) {
          betweenTurns = false;
          yield* resumeTurn("turn started");
        }
        if (retrying && isAssistantMessage(message)) yield* reportRecovery();
        if (Schema.is(ClaudeCompletionHeader)(message)) {
          const update = yield* decodeCompletionUpdate(message).pipe(
            Effect.mapError((cause) =>
              operationError("stream", spec, "Claude returned an invalid completion update", cause),
            ),
          );
          if (update.subtype === "background_tasks_changed") {
            // Each update replaces the whole task snapshot. Ambient watchers are excluded
            // because they are not work for the parent.
            backgroundTasks = update.tasks
              .filter((task) => task.ambient !== true)
              .map((task) => task.task_id);
            yield* Effect.logInfo("Claude background work changed", {
              sessionId: session.id,
              backgroundTaskIds: backgroundTasks,
            });
          } else {
            reportsSessionState = true;
            if (update.state !== "idle") yield* resumeTurn("turn started");
            const candidate = completedTurn;
            completedTurn = Option.none();
            // The SDK reports idle after the result flush and the background-notification loop.
            // An empty task snapshot alone does not finish the session, and a waiting turn's
            // answer is not reused before the notification has run.
            if (update.state === "idle" && Option.isSome(candidate)) {
              if (backgroundTasks.length === 0) yield* conversation.finish(candidate.value);
              else yield* awaitBackgroundWork(candidate.value);
            }
          }
          return;
        }
        const used = usage.read(message);
        if (Option.isSome(used))
          yield* channel.emit(SessionTokensUpdated.make({ session, ...used.value }));
        for (const event of sessionEventsFrom(message, session, tools, toolName)) {
          yield* channel.emit(event);
        }
        if (!Schema.is(ClaudeResultMessage)(message)) return;
        yield* resumeTurn("turn started");
        betweenTurns = true;
        completedTurn = Option.none();
        retries = 0;
        retrying = false;
        if (message.subtype !== "success" || message.result === undefined) {
          yield* channel.fail(provider.failedResult(message));
          return;
        }
        const refusal = provider.refusal(message);
        if (Option.isSome(refusal)) {
          yield* Effect.logWarning(
            "Claude turn ended on a provider capacity refusal or usage limit",
            {
              sessionId: session.id,
              apiErrorStatus: message.api_error_status,
              resetsAt: Option.getOrUndefined(
                Option.map(refusal.value.resetsAt, DateTime.formatIso),
              ),
            },
          );
          yield* channel.fail(refusal.value);
          return;
        }
        if (message.is_error === true)
          yield* Effect.logInfo(
            "Claude turn ended on an API error that is not a capacity refusal; its text is the session's answer",
            { sessionId: session.id, apiErrorStatus: message.api_error_status },
          );
        provider.clear();
        // Typed-prompt turns stamp only their first assistant frame, even after folding guidance.
        // A result that lists `user_message_uuids` already names every folded message.
        if (message.queued_turn_count !== undefined && Option.isNone(acknowledged)) {
          const read = submitted.splice(
            0,
            Math.max(0, submitted.length - message.queued_turn_count),
          );
          if (read.length > 0) {
            yield* Effect.logInfo("Claude result acknowledged submitted operator messages", {
              sessionId: session.id,
              read: read.length,
              queuedTurns: message.queued_turn_count,
            });
            yield* readAtResult(read);
          }
        }
        if (message.queued_turn_count !== undefined && message.queued_turn_count > 0) {
          // The last unread messages start the queued turns, which run after this result.
          const calls = yield* channel.toolCalls;
          for (const id of submitted.slice(-message.queued_turn_count))
            queuedTurnStarts.set(id, calls);
          yield* Effect.logInfo("Claude child has queued user turns", {
            sessionId: session.id,
            queuedTurns: message.queued_turn_count,
          });
          return;
        }
        const answer = message.result.trim() || "Claude child session completed";
        if (reportsSessionState) {
          completedTurn = Option.some(answer);
        } else if (backgroundTasks.length > 0) {
          yield* awaitBackgroundWork(answer);
        } else {
          // Older Claude Code versions on Workers do not send session-state messages.
          yield* conversation.finish(answer);
        }
      });

    /**
     * Applies `launch`'s messages until its output ends. Returns the error that broke the output,
     * or `None` if the output closed.
     */
    const drain = (launch: ClaudeLaunch) =>
      Effect.gen(function* () {
        let broken = Option.none<SessionOperationError>();
        yield* Stream.concat(
          Stream.fromIterable(launch.read),
          Stream.fromQueue(launch.output),
        ).pipe(
          Stream.map((message): Result.Result<Schema.Json, SessionOperationError> =>
            Result.succeed(message),
          ),
          Stream.catch((error): Stream.Stream<Result.Result<Schema.Json, SessionOperationError>> =>
            Stream.make(Result.fail(error)),
          ),
          Stream.runForEach(
            Result.match({
              onSuccess: (message) =>
                launch.covered.pipe(
                  Effect.flatMap((covered) =>
                    covered ? Effect.sync(() => usage.covered()) : Effect.void,
                  ),
                  Effect.andThen(handle(message)),
                  Effect.andThen(launch.acknowledge(message)),
                ),
              onFailure: (error) =>
                Effect.sync(() => {
                  broken = Option.some(error);
                }),
            }),
          ),
        );
        return broken;
      });

    const resume = Effect.fn("ClaudeRuntime.resume")(function* (error: SessionOperationError) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id, worker: spec.worker });
      if (!isRemoteHost(spec.host) || !Schema.is(ChildProcessLost)(error.cause))
        return yield* error;
      yield* Effect.logWarning("Remote Claude process stopped; resuming its saved session", {
        sessionId: session.id,
        harnessSessionId: reference.id,
        exitCode: error.cause.exitCode,
      });
      yield* Scope.close(current.scope, Exit.void);
      if ((yield* lifecycle.isStopping) || (yield* channel.isTerminal)) return;
      yield* channel.emit(SessionTokensUpdated.make({ session, ...usage.restart() }));
      yield* resumeTurn("process resumed");
      backgroundTasks = [];
      completedTurn = Option.none();
      reportsSessionState = false;
      provider.clear();
      retries = 0;
      retrying = false;
      const { sessionId: _assignedId, ...resumeOptions } = options;
      current = yield* policy.reopen(
        launchWithRetries(
          spec,
          { ...resumeOptions, resume: reference.id },
          server,
          [],
          scope,
          "replace",
        ),
      );
      submitted.length = 0;
      queuedTurnStarts.clear();
      // The new process runs no turn until recovery sends one.
      betweenTurns = true;
      yield* conversation.recover(
        policy,
        [...tools].map(([callId, tool]) => ({ callId, tool })),
        send,
      );
      tools.clear();
      yield* Effect.logInfo("Resumed the Claude child's session", {
        sessionId: session.id,
        harnessSessionId: reference.id,
      });
    });

    const consume = Effect.gen(function* () {
      for (;;) {
        const broken = yield* drain(current);
        if ((yield* lifecycle.isStopping) || (yield* channel.isTerminal)) return;
        const error = Option.getOrElse(broken, () =>
          operationError(
            "stream",
            spec,
            "Claude output closed without a result",
            new Error("unexpected end of output"),
          ),
        );
        yield* resume(error);
      }
    }).pipe(Effect.catch((error) => channel.fail(error)));
    yield* Effect.forkScoped(consume);

    const steer = Effect.fn("ClaudeRuntime.steer")((message: string, id?: OperatorMessageId) =>
      Effect.logDebug("Steering Claude child session", {
        sessionId: session.id,
      }).pipe(Effect.andThen(send(message, id))),
    );
    const interrupt = Effect.logInfo("Interrupting Claude child session", {
      sessionId: session.id,
    }).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => current.query.interrupt(),
          catch: (cause) => operationError("interrupt", spec, "Can't interrupt Claude", cause),
        }),
      ),
      Effect.tap(() => Effect.sync(() => current.input.end())),
      Effect.asVoid,
    );
    const running = {
      session,
      events: Stream.fromQueue(channel.events),
      interrupt,
      result: Deferred.await(channel.result),
      steer,
      intervene: conversation.intervene,
    } satisfies RunningSession;
    return {
      running,
      active: current.retained && !unprompted,
      recover: (tools: ReadonlyArray<InterruptedTool>) =>
        conversation.recover(policy, tools, steer, unprompted),
    };
  });
  const stop = Effect.fn("ClaudeRuntime.stop")(function* (spec: SessionSpec) {
    if (isRemoteHost(spec.host))
      yield* stopChildProcess({ ...spec, sessionId: Option.some(spec.session.id) }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
  });
  return {
    open: openWithTools(open),
    stop,
    // A completion serves no usine tools, so its launch gets no MCP server.
    complete: structuredCompletion(
      claudeCompletion(
        (spec, options, messages, scope) =>
          launchWithRetries(spec, options, Option.none(), messages, scope),
        billingPool,
      ),
    ),
  } satisfies Pick<HarnessRuntime, "open" | "stop" | "complete">;
});

/** Provides `ChildBackend` with Claude Code for every delegated task. */
export const claudeChildLayer = Layer.effect(
  ChildBackend,
  Effect.map(makeClaudeSessions, (sessions) =>
    childContinuation(HarnessCatalog.make({ descriptors: [claude] }), sessions),
  ),
);

/** Combines preflight and scoped sessions for registration. */
export const claudeRuntime = Effect.gen(function* () {
  const sessions = yield* makeClaudeSessions;
  const preflight = yield* claudePreflight;
  return { id: claude.id, preflight, ...sessions } satisfies HarnessRuntime;
});
