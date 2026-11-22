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
  HarnessSessionId,
  ProviderAnswered,
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
  FiberSet,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  type AgentCapacityError,
  HostLoginLock,
  ChildBackend,
  ChildSessionLifecycle,
  type InterruptedTool,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
} from "../../runtime.ts";
import { isRemoteHost } from "../../child-host/child-host.ts";
import { ChildProcessLost, stopChildProcess } from "../../child-host/process.ts";
import { sdkProcessSpawner } from "../../child-host/sdk.ts";
import { sessionChannel } from "../session.ts";
import { sessionConversation } from "../conversation.ts";
import { claudeSessionMeter, claudeTokenMeter, type RestoredUsage } from "../usage.ts";
import { structuredCompletion } from "../completion.ts";
import { claudeCompletion } from "./completion.ts";
import { brainOptions } from "./options.ts";
import { claudeProviderFailures } from "./provider.ts";
import {
  apiRetryMessage,
  backgroundWork,
  ClaudeApiRetry,
  ClaudeCompletionHeader,
  ClaudeResultMessage,
  claudeReceipts,
  decodeCompletionUpdate,
  isAssistantMessage,
  isModelAnswer,
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

/** Claude Code's tools that read and search files, which a role that keeps only `read` tools lists. */
const READ_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Returns the SDK options; each launch supplies the shared process callback. A role that closes
 * native tools gets no built-in tool, and a role that keeps only `read` tools gets only Claude
 * Code's read and search tools; neither gets an MCP server beyond its usine tools.
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
  switch (spec.admitted.role.nativeTools) {
    case "all":
      return options;
    case "read":
      return { ...options, tools: READ_TOOLS, strictMcpConfig: true };
    case "none":
      return { ...options, tools: [], strictMcpConfig: true };
  }
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

/** What one Claude Code launch serves and sends. */
interface LaunchInput {
  readonly tools: Option.Option<ClaudeToolServer>;
  /** The user messages to send; with none, the launch waits for input. */
  readonly messages: ReadonlyArray<ClaudeUserMessage>;
  /** Records that the process owner acknowledged the first user message. */
  readonly prompted: Effect.Effect<void, SessionOperationError>;
  readonly transport?: "replace" | "resume" | undefined;
}

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
  /** Whether the process owner acknowledged a user message of this launch. */
  readonly prompted: Effect.Effect<boolean>;
  /** Checkpoints a handled message. */
  readonly acknowledge: (message: Schema.Json) => Effect.Effect<void>;
  /** Whether the checkpoint covers every acknowledged message and the output read before it. */
  readonly covered: Effect.Effect<boolean>;
  /** The scope of the launch's process, input, and output reader. */
  readonly scope: Scope.Closeable;
}

/** What a Claude child session tracks about its Claude Code process and turns. */
interface ClaudeState {
  /** The launch whose process the session uses; a process resume replaces it. */
  readonly current: ClaudeLaunch;
  /** Whether the saved conversation holds the task, so recovery sends the continuation instead. */
  readonly taskSaved: boolean;
  /**
   * Whether Claude runs no turn, from a result until the next assistant message. A message sent
   * then starts the next turn instead of joining a running one.
   */
  readonly betweenTurns: boolean;
  /** The tool names of the calls that started and haven't finished, by call ID. */
  readonly tools: ReadonlyMap<string, string>;
  /** Whether Claude reports its session state, so that its idle state ends a turn. */
  readonly reportsSessionState: boolean;
  /** The answer of the last turn, until Claude reports that the session is idle. */
  readonly completedTurn: Option.Option<string>;
  /** The API retries reported in the current turn. */
  readonly retries: number;
  /** Whether the last API retry is unresolved. */
  readonly retrying: boolean;
  /** Whether the model answered since the current Claude process started. */
  readonly answered: boolean;
  /** Whether a report showed a request on usage credits that the spec allows. */
  readonly onUsageCredits: boolean;
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
   * Launches Claude Code once for `spec` and sends the launch's messages, keeping its Claude login
   * lock until the first messages decide the login state. With no messages, the launch waits for
   * input and skips the login check. Resources are added to the current scope.
   */
  const launchOnce = Effect.fn("ClaudeRuntime.launchOnce")(function* (
    spec: SessionSpec,
    options: ClaudeQueryOptions,
    { tools, messages, prompted: savePrompt, transport }: LaunchInput,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: spec.session.id, worker: spec.worker });
    const release = yield* holdLogin(spec);
    return yield* Effect.gen(function* () {
      const input = new AsyncInput();
      const prompted = yield* Ref.make(false);
      const recordPrompt = yield* Effect.cached(
        Ref.set(prompted, true).pipe(
          Effect.andThen(savePrompt),
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
        prompted: Ref.get(prompted),
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
    launch: LaunchInput,
    scope: Scope.Scope,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: spec.session.id, worker: spec.worker });
    let launchOptions = options;
    for (let retry = 0; ; retry += 1) {
      const launchScope = yield* Scope.fork(scope);
      const opened: ClaudeLaunch = {
        ...(yield* launchOnce(spec, launchOptions, launch).pipe(
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
            messages: launch.messages.length,
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
    /** The pause boundary that the hooks wait at, which the conversation supplies. */
    const boundary = yield* Deferred.make<Effect.Effect<void>>();
    const pauseAtBoundary: HookCallback = async (_input, _id, options) => {
      await Effect.runPromiseWith(context)(
        Effect.acquireUseRelease(
          Effect.forkIn(Effect.flatten(Deferred.await(boundary)), scope),
          Fiber.join,
          Fiber.interrupt,
        ),
        { signal: options.signal },
      );
      return {};
    };
    const { home, defaultHome } = environmentHome(spec.environment, "CLAUDE_CONFIG_DIR", ".claude");
    // Claude Code takes the conversation ID from its caller, so a new session gets one here.
    const reference = yield* Option.match(startReference(start), {
      onSome: Effect.succeed,
      onNone: () =>
        crypto.randomUUIDv4().pipe(
          Effect.orDie,
          Effect.map((id) =>
            HarnessSession.make({ id: HarnessSessionId.make(id), cwd: spec.cwd, home }),
          ),
        ),
    });
    const options: ClaudeQueryOptions = {
      ...optionsFor(spec, start, reference.id),
      hooks: {
        PreToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
        PostToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
      },
    };
    const lifecycle = yield* ChildSessionLifecycle.current;
    yield* checkContinuationHome(spec, start, home, defaultHome);
    yield* policy.journal.started(reference);
    // Login-lock retries finish before the session starts.
    const startsIdle = policy.restored.paused || Option.isSome(policy.restored.idle);
    // Claude names a message with a client UUID on each result that consumed it.
    const clientId = crypto.randomUUIDv4().pipe(Effect.orDie);
    const prompts = startsIdle
      ? []
      : yield* Effect.forEach(Option.toArray(startPrompt(start)), (text) =>
          Effect.map(clientId, (uuid) => userMessage(text, uuid)),
        );
    const launched = yield* launchWithRetries(
      spec,
      options,
      {
        tools: server,
        messages: prompts,
        prompted: policy.journal.prompted,
        transport: start._tag === "StartResume" ? "resume" : undefined,
      },
      scope,
    );

    const pool = yield* billingPool(spec, launched.query);
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
    // A retained process that never acknowledged its task waits for input without a turn.
    const unprompted = launched.retained && !policy.restored.prompted;
    const state = yield* Ref.make<ClaudeState>({
      current: launched,
      taskSaved: start._tag === "StartResume" && !unprompted,
      betweenTurns: launched.retained ? unprompted || startsIdle : prompts.length === 0,
      tools: new Map(),
      reportsSessionState: false,
      completedTurn: Option.none(),
      retries: 0,
      retrying: false,
      answered: false,
      onUsageCredits: false,
    });
    channel.onTerminal(() => {
      Ref.getUnsafe(state).current.input.end();
    });
    yield* channel.emit(SessionStarted.make({ session, harnessSession: Option.some(reference) }));
    if (unprompted)
      yield* Effect.logWarning("The retained Claude process never received its task", {
        sessionId: session.id,
        harnessSessionId: reference.id,
      });
    /**
     * Sends `message` to Claude. During a turn, Claude queues it until a tool call returns or the
     * turn ends; between turns, it starts the next turn.
     */
    const send = Effect.fn("ClaudeRuntime.send")(function* (
      message: string,
      id?: OperatorMessageId,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      const uuid = id ?? (yield* clientId);
      const { current, betweenTurns } = yield* Ref.get(state);
      yield* Effect.try({
        try: () => current.input.offer(userMessage(message, uuid)),
        catch: (cause) => operationError("steer", spec, "Can't send a message to Claude", cause),
      });
      return betweenTurns ? ("next-turn" as const) : ("queued" as const);
    });
    const conversation = yield* sessionConversation({
      session,
      channel,
      policy,
      submitted: launched.retained && !unprompted ? policy.restored.unread.map(({ id }) => id) : [],
      decode: claudeReceipts,
      send: (message, _activity, id) => send(message, id),
      pause: Effect.void,
      beforeFinish: Effect.void,
      maxBackgroundWaitMinutes: spec.maxBackgroundWaitMinutes,
    });
    yield* Deferred.succeed(boundary, conversation.awaitUnpaused);
    const usage = claudeSessionMeter(
      Option.getOrUndefined(policy.restored.usage),
      launched.retained,
    );
    const reportRetry = Effect.fn("ClaudeRuntime.reportRetry")(function* (
      retry: typeof ClaudeApiRetry.Type,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      const retries = yield* Ref.modify(state, (current) => [
        current.retries + 1,
        { ...current, retries: current.retries + 1, retrying: true },
      ]);
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
      const { retries } = yield* Ref.getAndUpdate(state, (current) => ({
        ...current,
        retrying: false,
      }));
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
    const reportAnswer = Effect.fn("ClaudeRuntime.reportAnswer")(function* () {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      yield* Ref.update(state, (current) => ({ ...current, answered: true }));
      yield* Effect.logInfo(
        "Claude child got its provider's first answer since the process started",
        {
          sessionId: session.id,
        },
      );
      yield* channel.emit(ProviderAnswered.make({ session }));
    });

    const provider = claudeProviderFailures(session);
    /**
     * Fails the session with `refusal` when a request ran on usage credits that the spec doesn't
     * allow. Closing the failed child ends its Claude Code process. With credits allowed, logs the
     * first such request.
     */
    const reportUsageCredits = Effect.fn("ClaudeRuntime.reportUsageCredits")(function* (
      refusal: AgentCapacityError,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id });
      const resetsAt = Option.getOrUndefined(Option.map(refusal.resetsAt, DateTime.formatIso));
      if (spec.allowUsageCredits) {
        const first = yield* Ref.modify(state, (current) => [
          !current.onUsageCredits,
          { ...current, onUsageCredits: true },
        ]);
        if (!first) return;
        yield* Effect.logInfo("Claude child runs on usage credits, which its spec allows", {
          sessionId: session.id,
          planResetsAt: resetsAt,
        });
        return;
      }
      if (yield* channel.isTerminal) return;
      yield* Effect.logWarning(
        "Claude child ran a request on usage credits, which its spec doesn't allow; stopping it",
        { sessionId: session.id, resetsAt },
      );
      yield* channel.fail(refusal);
    });

    /** Logs how a new process's first result settled the usage that Claude restored. */
    const logRestored = ({ resultTokens, processTokens, restored }: RestoredUsage) =>
      Option.match(processTokens, {
        onNone: () =>
          Effect.logInfo(
            "Claude result reports no usage of this process alone; counting all of it",
            { sessionId: session.id, resultTokens },
          ),
        onSome: (processTokens) =>
          restored.totalTokens > 0
            ? Effect.logInfo("Claude restored the resumed session's usage; counting it once", {
                sessionId: session.id,
                resultTokens,
                processTokens,
                restoredTokens: restored.totalTokens,
              })
            : Effect.logInfo("Claude restored no usage of the resumed session", {
                sessionId: session.id,
                resultTokens,
                processTokens,
              }),
      });

    /** Applies one message from Claude to the session. */
    const handle = (message: Schema.Json) =>
      Effect.gen(function* () {
        const { betweenTurns } = yield* Ref.get(state);
        yield* conversation.observe({ message, betweenTurns });
        const reported = yield* provider.read(message);
        if (Option.isSome(reported.rateLimits)) yield* channel.emit(reported.rateLimits.value);
        if (Option.isSome(reported.usageCredits))
          yield* reportUsageCredits(reported.usageCredits.value);
        else if (Option.isSome(reported.rejectedUntil))
          yield* Effect.logWarning("Claude reports that its usage limit rejects requests", {
            sessionId: session.id,
            resetsAt: DateTime.formatIso(reported.rejectedUntil.value),
          });
        if (Option.isSome(reported.retry)) return yield* reportRetry(reported.retry.value);
        if (isAssistantMessage(message)) {
          yield* Ref.update(state, (current) => ({ ...current, betweenTurns: false }));
          yield* conversation.turnStarted;
        }
        if (isModelAnswer(message)) {
          const { retrying, answered } = yield* Ref.get(state);
          if (retrying) yield* reportRecovery();
          if (!answered) yield* reportAnswer();
        }
        if (Schema.is(ClaudeCompletionHeader)(message)) {
          const update = yield* decodeCompletionUpdate(message).pipe(
            Effect.mapError((cause) =>
              operationError("stream", spec, "Claude returned an invalid completion update", cause),
            ),
          );
          if (update.subtype === "background_tasks_changed") {
            yield* conversation.reportBackground(Option.some(backgroundWork(update)));
          } else {
            const candidate = yield* Ref.modify(state, (current) => [
              current.completedTurn,
              { ...current, reportsSessionState: true, completedTurn: Option.none() },
            ]);
            if (update.state !== "idle") yield* conversation.turnStarted;
            // The SDK reports idle after the result flush and the background-notification loop.
            // An empty task snapshot alone does not finish the session, and a waiting turn's
            // answer is not reused before the notification has run.
            if (update.state === "idle" && Option.isSome(candidate))
              yield* conversation.finish(candidate.value);
          }
          return;
        }
        const used = usage.read(message);
        if (Option.isSome(used)) {
          if (Option.isSome(used.value.restored)) yield* logRestored(used.value.restored.value);
          yield* channel.emit(SessionTokensUpdated.make({ session, ...used.value.usage }));
        }
        const events = yield* Ref.modify(state, (current) => {
          const read = sessionEventsFrom(message, session, current.tools, toolName);
          return [read.events, { ...current, tools: read.tools }];
        });
        for (const event of events) yield* channel.emit(event);
        if (!Schema.is(ClaudeResultMessage)(message)) return;
        yield* conversation.turnStarted;
        yield* Ref.update(state, (current) => ({
          ...current,
          betweenTurns: true,
          completedTurn: Option.none(),
          retries: 0,
          retrying: false,
        }));
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
        // The queued turns run after this result; the last unread messages start them.
        if (message.queued_turn_count !== undefined && message.queued_turn_count > 0) {
          yield* Effect.logInfo("Claude child has queued user turns", {
            sessionId: session.id,
            queuedTurns: message.queued_turn_count,
          });
          return;
        }
        const answer = message.result.trim() || "Claude child session completed";
        const { reportsSessionState } = yield* Ref.get(state);
        if (reportsSessionState) {
          yield* Ref.update(state, (current) => ({
            ...current,
            completedTurn: Option.some(answer),
          }));
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
      Stream.concat(Stream.fromIterable(launch.read), Stream.fromQueue(launch.output)).pipe(
        Stream.map((message): Result.Result<Schema.Json, SessionOperationError> =>
          Result.succeed(message),
        ),
        Stream.catch((error): Stream.Stream<Result.Result<Schema.Json, SessionOperationError>> =>
          Stream.make(Result.fail(error)),
        ),
        Stream.runFoldEffect(
          () => Option.none<SessionOperationError>(),
          (broken, next) =>
            Result.match(next, {
              onSuccess: (message) =>
                launch.covered.pipe(
                  Effect.flatMap((covered) =>
                    covered ? Effect.sync(() => usage.covered()) : Effect.void,
                  ),
                  Effect.andThen(handle(message)),
                  Effect.andThen(launch.acknowledge(message)),
                  Effect.as(broken),
                ),
              onFailure: (error) => Effect.succeedSome(error),
            }),
        ),
      );

    const resume = Effect.fn("ClaudeRuntime.resume")(function* (error: SessionOperationError) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id, worker: spec.worker });
      if (!isRemoteHost(spec.host) || !Schema.is(ChildProcessLost)(error.cause))
        return yield* error;
      yield* Effect.logWarning("Remote Claude process stopped; resuming its saved session", {
        sessionId: session.id,
        harnessSessionId: reference.id,
        exitCode: error.cause.exitCode,
      });
      const { current: lost } = yield* Ref.get(state);
      const prompted = yield* lost.prompted;
      yield* Scope.close(lost.scope, Exit.void);
      if ((yield* lifecycle.isStopping) || (yield* channel.isTerminal)) return;
      const empty = !(yield* Ref.modify(state, (current) => {
        const taskSaved = current.taskSaved || prompted;
        return [taskSaved, { ...current, taskSaved }];
      }));
      yield* channel.emit(SessionTokensUpdated.make({ session, ...usage.restart() }));
      yield* conversation.processRestarted;
      provider.clear();
      yield* Ref.update(state, (current) => ({
        ...current,
        completedTurn: Option.none(),
        reportsSessionState: false,
        retries: 0,
        retrying: false,
        answered: false,
      }));
      const { sessionId: _assignedId, resume: _resumedId, ...resumeOptions } = options;
      const relaunched = yield* policy.reopen(
        launchWithRetries(
          spec,
          { ...resumeOptions, ...(empty ? { sessionId: reference.id } : { resume: reference.id }) },
          { tools: server, messages: [], prompted: policy.journal.prompted, transport: "replace" },
          scope,
        ),
      );
      // The new process runs no turn until recovery sends one.
      const { tools } = yield* Ref.getAndUpdate(state, (current) => ({
        ...current,
        current: relaunched,
        betweenTurns: true,
        tools: new Map(),
      }));
      yield* conversation.recover(
        [...tools].map(([callId, tool]) => ({ callId, tool })),
        send,
        empty,
      );
      yield* Effect.logInfo("Resumed the Claude child's session", {
        sessionId: session.id,
        harnessSessionId: reference.id,
      });
    });

    const consume = Effect.gen(function* () {
      for (;;) {
        const { current } = yield* Ref.get(state);
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
      }).pipe(Effect.andThen(send(message, id)), Effect.asVoid),
    );
    const interrupt = Effect.logInfo("Interrupting Claude child session", {
      sessionId: session.id,
    }).pipe(
      Effect.andThen(Ref.get(state)),
      Effect.flatMap(({ current }) =>
        Effect.tryPromise({
          try: () => current.query.interrupt(),
          catch: (cause) => operationError("interrupt", spec, "Can't interrupt Claude", cause),
        }).pipe(Effect.andThen(Effect.sync(() => current.input.end()))),
      ),
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
      active: launched.retained && !unprompted,
      recover: (tools: ReadonlyArray<InterruptedTool>) =>
        conversation.recover(tools, send, unprompted),
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
          launchWithRetries(
            spec,
            options,
            { tools: Option.none(), messages, prompted: Effect.void },
            scope,
          ),
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
