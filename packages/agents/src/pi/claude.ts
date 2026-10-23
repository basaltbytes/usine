import {
  query as openClaudeQuery,
  type Options,
  type HookCallback,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionEvent,
  ChildSession,
  HarnessSession,
  HarnessSessionId,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import {
  type Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  AgentResultError,
  ClaudeChildBackend,
  ClaudeLoginLock,
  ChildBackend,
  type ChildRequest,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
} from "../runtime.ts";
import { childPidFile, type RemoteShell, sshArguments } from "../child-host/child-host.ts";
import { sessionChannel } from "./session.ts";
import { sessionConversation } from "./conversation.ts";
import { claudeTokenMeter } from "./usage.ts";

export interface ClaudeUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly parent_tool_use_id: null;
}

export type ClaudeQueryOptions = Pick<
  Options,
  | "allowDangerouslySkipPermissions"
  | "cwd"
  | "effort"
  | "env"
  | "model"
  | "pathToClaudeCodeExecutable"
  | "permissionMode"
  | "persistSession"
  | "settingSources"
  | "spawnClaudeCodeProcess"
  | "thinking"
  | "hooks"
>;

export interface ClaudeModelInfo {
  readonly value: string;
  readonly resolvedModel?: string;
}

/** A running Claude Code session: its message stream, model list, and stop controls. */
export interface ClaudeQuery extends AsyncIterable<Schema.Json> {
  readonly close: () => void;
  readonly interrupt: () => Promise<void>;
  readonly supportedModels: () => Promise<ReadonlyArray<ClaudeModelInfo>>;
}

/** The service that opens Claude Code sessions. */
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    readonly open: (
      input: AsyncIterable<ClaudeUserMessage>,
      options: ClaudeQueryOptions,
    ) => ClaudeQuery;
  }
>()("@usine/agents/pi/ClaudeSdk") {}

const decodeVendorMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const vendorMessageJson = (message: SDKMessage): Schema.Json =>
  decodeVendorMessage(JSON.stringify(message));

export const claudeSdkLive = Layer.succeed(ClaudeSdk)({
  open: (input, options) => {
    // SAFETY: ClaudeUserMessage is the streaming-input subset of SDKUserMessage.
    const query = openClaudeQuery({ prompt: input as AsyncIterable<SDKUserMessage>, options });
    return {
      close: () => query.close(),
      interrupt: async () => {
        await query.interrupt();
      },
      supportedModels: () => query.supportedModels(),
      async *[Symbol.asyncIterator]() {
        for await (const message of query) yield vendorMessageJson(message);
      },
    };
  },
});

class AsyncInput implements AsyncIterable<ClaudeUserMessage> {
  readonly #buffer: Array<ClaudeUserMessage> = [];
  readonly #waiters: Array<(value: IteratorResult<ClaudeUserMessage>) => void> = [];
  #ended = false;

  offer(message: ClaudeUserMessage): void {
    if (this.#ended) throw new Error("Claude input is closed");
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#buffer.push(message);
    else waiter({ done: false, value: message });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeUserMessage> {
    return {
      next: () => {
        const value = this.#buffer.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

const userMessage = (content: string): ClaudeUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
});

const operationError = (
  operation: SessionOperationError["operation"],
  request: ChildRequest,
  message: string,
  cause: unknown,
): SessionOperationError =>
  new SessionOperationError({
    operation,
    sessionId: Option.some(request.session.id),
    message,
    cause,
  });

/**
 * Returns a spawner that runs Claude Code on the remote host as one SSH command, with the SDK's
 * command, arguments, working directory, and environment in the remote command line. The abort
 * signal stops the SSH client.
 */
const sshSpawner =
  (host: RemoteShell, pidFile: string, onStderr: (text: string) => void) =>
  (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(
      host.ssh.command,
      sshArguments(host, {
        cwd: options.cwd,
        environment: options.env,
        pidFile,
        command: options.command,
        args: options.args,
      }),
      {
        env: { ...host.sshEnvironment },
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stderr.setEncoding("utf8").on("data", onStderr);
    return child;
  };

const optionsFor = (
  request: ChildRequest,
  onStderr: (text: string) => void,
): ClaudeQueryOptions => {
  const effort = request.session.brain.effort;
  const shared: Omit<ClaudeQueryOptions, "effort" | "thinking"> = {
    allowDangerouslySkipPermissions: true,
    cwd: request.cwd,
    // Replaces the subprocess environment instead of extending this process's.
    env: { ...request.environment },
    model: request.session.brain.model,
    // The Worker-provisioned binary that the readiness checks inspect.
    pathToClaudeCodeExecutable: "claude",
    permissionMode: "bypassPermissions",
    persistSession: true,
    // The worktree is untrusted, so its project and local settings (hooks, env) are not loaded into
    // a child that has the App credential; only the Worker user's settings apply.
    settingSources: ["user"],
    // On a local host, the SDK spawns the process itself.
    ...(request.host._tag === "RemoteShell" && {
      spawnClaudeCodeProcess: sshSpawner(
        request.host,
        childPidFile(request.cwd, request.session.id),
        onStderr,
      ),
    }),
  };
  return effort === "off"
    ? { ...shared, thinking: { type: "disabled" } }
    : {
        ...shared,
        effort: effort === "minimal" ? "low" : effort,
        thinking: { type: "adaptive" },
      };
};

const modelExists = (models: ReadonlyArray<ClaudeModelInfo>, model: ModelId): boolean =>
  models.some((candidate) => candidate.value === model || candidate.resolvedModel === model);

const decodeClaudeInit = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("init"),
    session_id: HarnessSessionId,
  }),
);

const ClaudeTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.NonEmptyString,
});
const ClaudeContentMessage = Schema.Struct({
  type: Schema.Literals(["assistant", "user"]),
  message: Schema.Struct({ content: Schema.Array(Schema.Json) }),
});
const ClaudeToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  input: Schema.Json,
});
const ClaudeToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.NonEmptyString,
  content: Schema.Json,
  is_error: Schema.optionalKey(Schema.Boolean),
});
const ClaudeResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  result: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
  queued_turn_count: Schema.optionalKey(Schema.Number),
});
const ClaudeBackgroundTasks = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("background_tasks_changed"),
  tasks: Schema.Array(
    Schema.Struct({
      task_id: Schema.NonEmptyString,
      ambient: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const ClaudeSessionState = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("session_state_changed"),
  state: Schema.Literals(["idle", "running", "requires_action"]),
});

const ClaudeCompletionHeader = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literals(["background_tasks_changed", "session_state_changed"]),
});
const decodeCompletionUpdate = Schema.decodeUnknownEffect(
  Schema.Union([ClaudeBackgroundTasks, ClaudeSessionState]),
);

/** Claude Code's report of a failed API request that it retries; a `null` status means no response was received. */
const ClaudeApiRetry = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("api_retry"),
  attempt: Schema.Number,
  max_retries: Schema.Number,
  retry_delay_ms: Schema.Number,
  error_status: Schema.NullOr(Schema.Number),
  error: Schema.String,
});
const decodeApiRetry = Schema.decodeUnknownOption(ClaudeApiRetry);
const isAssistantMessage = Schema.is(Schema.Struct({ type: Schema.Literal("assistant") }));

/** Returns an API retry's fields as one sentence, because Claude Code includes no message. */
const apiRetryMessage = (retry: typeof ClaudeApiRetry.Type): string => {
  const failure =
    retry.error_status === null ? "without a response" : `with HTTP ${retry.error_status}`;
  const delay =
    retry.retry_delay_ms < 1_000
      ? `${retry.retry_delay_ms}ms`
      : `${Math.round(retry.retry_delay_ms / 1_000)}s`;
  return `API request failed ${failure} (${retry.error}); retry ${retry.attempt} of ${retry.max_retries} in ${delay}`;
};

/**
 * The text Claude Code ends a turn with if another Claude process has the login refresh lock, or
 * exited while it had the lock.
 */
const LOGIN_CONTENDED = "Failed to refresh OAuth token: another Claude Code process";

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
 * The maximum time a launch keeps the Worker's Claude login lock while waiting for a message that
 * decides the login state. If no such message arrives, the launch continues as a started session.
 */
const LOGIN_WINDOW = Duration.seconds(60);

/** Messages that arrive only after an API request was sent with a working login. */
const ClaudeLoginEvidence = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["rate_limit_event", "stream_event"]) }),
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literals(["api_retry", "thinking_tokens"]),
  }),
]);

const mentionsLoginContention = (text: string): boolean => text.includes(LOGIN_CONTENDED);

/** The login state shown by a launch's messages so far. */
type LoginCheck = "waiting" | "loggedIn" | "contended";

/**
 * Returns the login state shown by one of a launch's first messages. `init` and other session
 * notices can arrive before the first API request, where Claude refreshes an expired login, so they
 * return `waiting`. A model answer, rate-limit or thinking update, API retry, or result returns
 * `loggedIn`, except a result with the refresh lock error and no tokens used, which returns
 * `contended`. The synthetic answer with the same error returns `waiting` until that result.
 */
const loginCheck = (message: Schema.Json, spentTokens: boolean): LoginCheck => {
  if (Schema.is(ClaudeResultMessage)(message)) {
    const reported = [
      ...(message.result === undefined ? [] : [message.result]),
      ...(message.errors ?? []),
    ];
    return !spentTokens && reported.some(mentionsLoginContention) ? "contended" : "loggedIn";
  }
  if (Schema.is(ClaudeContentMessage)(message) && message.type === "assistant") {
    const contended = message.message.content.some(
      (block) => Schema.is(ClaudeTextBlock)(block) && mentionsLoginContention(block.text),
    );
    return contended && !spentTokens ? "waiting" : "loggedIn";
  }
  return Schema.is(ClaudeLoginEvidence)(message) ? "loggedIn" : "waiting";
};

/** One Claude Code launch for a child. */
interface ClaudeLaunch {
  readonly input: AsyncInput;
  readonly query: ClaudeQuery;
  /** The messages read by the login check, in order; later messages are in `output`. */
  readonly read: ReadonlyArray<Schema.Json>;
  readonly output: Queue.Dequeue<Schema.Json, SessionOperationError | Cause.Done>;
  /** The login state shown by `read`; `undecided` if the output ended or failed, or nothing decided it in time. */
  readonly login: Exclude<LoginCheck, "waiting"> | "undecided";
}

const sessionEventsFrom = (
  message: Schema.Json,
  session: ChildSession,
  tools: Map<string, string>,
): ReadonlyArray<AgentSessionEvent> => {
  if (!Schema.is(ClaudeContentMessage)(message)) return [];
  const events: Array<AgentSessionEvent> = [];
  for (const block of message.message.content) {
    // Emits only text blocks of completed assistant messages; streaming deltas are not recorded.
    if (message.type === "assistant" && Schema.is(ClaudeTextBlock)(block)) {
      events.push(new TextOutput({ session, text: block.text }));
    } else if (Schema.is(ClaudeToolUseBlock)(block)) {
      tools.set(block.id, block.name);
      events.push(
        new ToolStarted({
          session,
          callId: block.id,
          tool: block.name,
          input: block.input,
        }),
      );
    } else if (Schema.is(ClaudeToolResultBlock)(block)) {
      events.push(
        new ToolFinished({
          session,
          callId: block.tool_use_id,
          tool: tools.get(block.tool_use_id) ?? "unknown",
          output: block.content,
          isError: block.is_error === true,
        }),
      );
    }
  }
  return events;
};

const makeClaudeChild = Effect.gen(function* () {
  const sdk = yield* ClaudeSdk;
  const logins = yield* ClaudeLoginLock;

  /**
   * Acquires the request Worker's login lock in a fiber of the current scope and returns an effect
   * that releases it. The lock is also released after `LOGIN_WINDOW`, so a hung launch does not
   * block other Claude launches and preflights on the Worker.
   */
  const holdLogin = Effect.fn("ClaudeChildBackend.holdLogin")(function* (request: ChildRequest) {
    yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, worker: request.worker });
    const held = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      logins.withLock(request.worker)(
        Deferred.succeed(held, undefined).pipe(
          Effect.andThen(Deferred.await(released)),
          Effect.timeoutOption(LOGIN_WINDOW),
          Effect.flatMap(
            Option.match({
              onSome: () => Effect.void,
              onNone: () =>
                Effect.logWarning(
                  "Claude child showed no sign of its login in time; releasing the Worker's Claude login lock",
                  { sessionId: request.session.id, worker: request.worker },
                ),
            }),
          ),
        ),
      ),
    );
    yield* Deferred.await(held);
    yield* Effect.logDebug("Holding the Worker's Claude login lock to launch the child", {
      sessionId: request.session.id,
      worker: request.worker,
    });
    return Deferred.succeed(released, undefined).pipe(Effect.asVoid);
  });

  /** Reads messages from `output` into `read` until one decides the login state. */
  const checkLogin = Effect.fn("ClaudeChildBackend.checkLogin")(function* (
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
      spentTokens ||= Option.exists(tokens(next.success), ({ totalTokens }) => totalTokens > 0);
      const check = loginCheck(next.success, spentTokens);
      if (check !== "waiting") return check;
    }
  });

  /**
   * Launches Claude Code once for `request` and sends the task, keeping the Worker's login lock until
   * the first messages decide the login state. Resources are added to the current scope.
   */
  const launchOnce = Effect.fn("ClaudeChildBackend.launchOnce")(function* (
    request: ChildRequest,
    options: ClaudeQueryOptions,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, worker: request.worker });
    const release = yield* holdLogin(request);
    return yield* Effect.gen(function* () {
      const input = new AsyncInput();
      const query = sdk.open(input, options);
      const output = yield* Queue.make<Schema.Json, SessionOperationError | Cause.Done>();
      yield* Effect.forkScoped(
        Stream.fromAsyncIterable(query, (cause) =>
          operationError("stream", request, "Claude output stream failed", cause),
        ).pipe(Stream.runIntoQueue(output)),
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
        catch: (cause) => operationError("launch", request, "Claude model discovery failed", cause),
      });
      if (!modelExists(models, request.session.brain.model)) {
        yield* Effect.logError("Claude child rejected an unknown model");
        return yield* new UnknownModelError({
          harness: "claude",
          model: request.session.brain.model,
          message: `Claude does not expose model ${request.session.brain.model}`,
        });
      }
      input.offer(userMessage(request.prompt));
      const read: Array<Schema.Json> = [];
      const login = Option.getOrElse(
        yield* checkLogin(output, read).pipe(Effect.timeoutOption(LOGIN_WINDOW)),
        () => "undecided" as const,
      );
      yield* Effect.logDebug("Claude child's first messages settled its login check", {
        sessionId: request.session.id,
        worker: request.worker,
        login,
        messages: read.length,
      });
      return { input, query, read, output, login } satisfies ClaudeLaunch;
    }).pipe(Effect.ensuring(release));
  });

  /**
   * Launches Claude Code for `request`, relaunching after each delay in `LOGIN_RETRY_DELAYS` while it
   * fails on the login refresh lock. Each launch has its own scope inside `scope`, closed before the
   * next, so a failed launch's process and messages do not reach the session.
   */
  const launchWithRetries = Effect.fn("ClaudeChildBackend.launchWithRetries")(function* (
    request: ChildRequest,
    options: ClaudeQueryOptions,
    scope: Scope.Scope,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, worker: request.worker });
    for (let retry = 0; ; retry += 1) {
      const launchScope = yield* Scope.fork(scope);
      const opened = yield* launchOnce(request, options).pipe(Scope.provide(launchScope));
      if (opened.login !== "contended") {
        if (opened.login === "undecided")
          yield* Effect.logInfo("Claude child started without showing whether its login worked", {
            sessionId: request.session.id,
            worker: request.worker,
          });
        return opened;
      }
      const delay = LOGIN_RETRY_DELAYS[retry];
      if (delay === undefined) {
        yield* Effect.logWarning(
          "Claude child still could not refresh the Worker's Claude login; returning the error to the parent",
          {
            sessionId: request.session.id,
            parentSessionId: request.session.parentId,
            worker: request.worker,
            retries: retry,
          },
        );
        return opened;
      }
      yield* Scope.close(launchScope, Exit.void);
      yield* Effect.logInfo(
        "Claude child could not refresh the Worker's Claude login; launching it again",
        {
          sessionId: request.session.id,
          parentSessionId: request.session.parentId,
          worker: request.worker,
          retry: retry + 1,
          maxRetries: LOGIN_RETRY_DELAYS.length,
          delay: Duration.format(delay),
        },
      );
      yield* Effect.sleep(delay);
    }
  });

  const launch: ChildBackend["Service"]["launch"] = Effect.fn("ClaudeChildBackend.launch")(
    function* (request) {
      yield* Effect.annotateCurrentSpan({
        agent: request.session.agent,
        effort: request.session.brain.effort,
        harness: request.session.brain.harness,
        model: request.session.brain.model,
        parentSessionId: request.session.parentId,
        sessionId: request.session.id,
        worker: request.worker,
      });
      yield* Effect.logInfo("Launching Claude child session");
      const context = yield* Effect.context<never>();
      const scope = yield* Effect.scope;
      let boundary = Effect.void;
      const pauseAtBoundary: HookCallback = async (_input, _id, options) => {
        await Effect.runPromiseWith(context)(
          Effect.acquireUseRelease(
            Effect.forkIn(
              Effect.suspend(() => boundary),
              scope,
            ),
            Fiber.join,
            Fiber.interrupt,
          ),
          { signal: options.signal },
        );
        return {};
      };
      const { input, query, read, output } = yield* launchWithRetries(
        request,
        {
          ...optionsFor(request, (text) => {
            Effect.runForkWith(context)(
              Effect.logDebug("Claude child stderr", {
                sessionId: request.session.id,
                text: text.trimEnd(),
              }),
            );
          }),
          hooks: {
            PreToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
            PostToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
          },
        },
        scope,
      );

      const channel = yield* sessionChannel({
        label: "Claude child session",
        sessionId: request.session.id,
      });
      channel.onTerminal(() => {
        input.end();
      });
      const conversation = yield* sessionConversation({
        session: request.session,
        channel,
        // A message sent during a turn is queued until a tool call returns or the turn ends.
        send: (message, activity) =>
          Effect.try({
            try: () => input.offer(userMessage(message)),
            catch: (cause) =>
              operationError("steer", request, "Could not send a message to Claude", cause),
          }).pipe(Effect.as(activity === "idle" ? ("read" as const) : ("queued" as const))),
        pause: Effect.void,
        beforeFinish: Effect.void,
      });
      boundary = conversation.awaitUnpaused;
      const tools = new Map<string, string>();
      const tokens = claudeTokenMeter();
      let backgroundTasks: ReadonlyArray<string> = [];
      let reportsSessionState = false;
      let completedTurn = Option.none<string>();
      // Claude sends `init` with one session ID before each turn; the first is the launch record.
      const launched = yield* Ref.make(false);
      // API retries reported in the current turn, and whether the last retry is unresolved.
      let retries = 0;
      let retrying = false;

      const reportRetry = Effect.fn("ClaudeChildBackend.reportRetry")(function* (
        retry: typeof ClaudeApiRetry.Type,
      ) {
        yield* Effect.annotateCurrentSpan({ sessionId: request.session.id });
        retries += 1;
        retrying = true;
        const message = apiRetryMessage(retry);
        yield* Effect.logWarning("Claude child cannot reach its provider and will retry", {
          sessionId: request.session.id,
          retries,
          message,
          status: retry.error_status,
          error: retry.error,
        });
        yield* channel.emit(
          new ProviderRetrying({
            session: request.session,
            message,
            retries: ProviderRetries.make(retries),
          }),
        );
      });
      const reportRecovery = Effect.fn("ClaudeChildBackend.reportRecovery")(function* () {
        yield* Effect.annotateCurrentSpan({ sessionId: request.session.id });
        retrying = false;
        yield* Effect.logInfo("Claude child reached its provider again", {
          sessionId: request.session.id,
          retries,
        });
        yield* channel.emit(
          new ProviderRecovered({
            session: request.session,
            retries: ProviderRetries.make(retries),
          }),
        );
      });

      const consume = Stream.concat(Stream.fromIterable(read), Stream.fromQueue(output)).pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            const retry = decodeApiRetry(message);
            if (Option.isSome(retry)) return yield* reportRetry(retry.value);
            if (retrying && isAssistantMessage(message)) yield* reportRecovery();
            if (Schema.is(ClaudeCompletionHeader)(message)) {
              const update = yield* decodeCompletionUpdate(message).pipe(
                Effect.mapError((cause) =>
                  operationError(
                    "stream",
                    request,
                    "Claude returned an invalid completion update",
                    cause,
                  ),
                ),
              );
              if (update.subtype === "background_tasks_changed") {
                // Each update replaces the whole task snapshot. Ambient watchers are excluded
                // because they are not work for the parent.
                backgroundTasks = update.tasks
                  .filter((task) => task.ambient !== true)
                  .map((task) => task.task_id);
                yield* Effect.logInfo("Claude background work changed", {
                  sessionId: request.session.id,
                  backgroundTaskIds: backgroundTasks,
                });
              } else {
                reportsSessionState = true;
                const candidate = completedTurn;
                completedTurn = Option.none();
                // The SDK reports idle after the result flush and the background-notification loop.
                // An empty task snapshot alone does not finish the session, and a waiting turn's
                // answer is not reused before the notification has run.
                if (update.state === "idle" && Option.isSome(candidate)) {
                  if (backgroundTasks.length === 0) yield* conversation.finish(candidate.value);
                  else
                    yield* Effect.logInfo("Claude child is waiting for background work", {
                      sessionId: request.session.id,
                      backgroundTaskIds: backgroundTasks,
                    });
                }
              }
              return;
            }
            const init = decodeClaudeInit(message);
            if (Option.isSome(init) && !(yield* Ref.getAndSet(launched, true))) {
              const harnessSession = new HarnessSession({
                id: init.value.session_id,
                cwd: request.cwd,
              });
              yield* channel.emit(
                new SessionStarted({
                  session: request.session,
                  harnessSession: Option.some(harnessSession),
                }),
              );
              yield* Effect.logInfo("Claude child session saved", {
                sessionId: request.session.id,
                parentSessionId: request.session.parentId,
                harnessSessionId: harnessSession.id,
                cwd: harnessSession.cwd,
              });
            }
            const usage = tokens(message);
            if (Option.isSome(usage))
              yield* channel.emit(
                new SessionTokensUpdated({ session: request.session, ...usage.value }),
              );
            for (const event of sessionEventsFrom(message, request.session, tools)) {
              yield* channel.emit(event);
            }
            if (!Schema.is(ClaudeResultMessage)(message)) return;
            completedTurn = Option.none();
            retries = 0;
            retrying = false;
            if (message.subtype !== "success" || message.result === undefined) {
              const detail = message.errors?.join("; ") ?? "Claude returned an unsuccessful result";
              yield* channel.fail(
                new AgentResultError({
                  sessionId: Option.some(request.session.id),
                  message: detail,
                }),
              );
              return;
            }
            const stillQueued = message.queued_turn_count;
            // Claude has read every queued message except those still queued as separate turns.
            if (stillQueued !== undefined)
              yield* conversation.read((queued) => queued.length - stillQueued);
            if (message.queued_turn_count !== undefined && message.queued_turn_count > 0) {
              yield* Effect.logInfo("Claude child has queued user turns", {
                sessionId: request.session.id,
                queuedTurns: message.queued_turn_count,
              });
              return;
            }
            const answer = message.result.trim() || "Claude child session completed";
            if (reportsSessionState) {
              completedTurn = Option.some(answer);
            } else if (backgroundTasks.length > 0) {
              yield* Effect.logInfo("Claude child is waiting for background work", {
                sessionId: request.session.id,
                backgroundTaskIds: backgroundTasks,
              });
            } else {
              // Older Claude Code versions on Workers do not send session-state messages.
              yield* conversation.finish(answer);
            }
          }),
        ),
        Effect.flatMap(() =>
          channel.isTerminal.pipe(
            Effect.flatMap((done) =>
              done
                ? Effect.void
                : channel.fail(
                    operationError(
                      "stream",
                      request,
                      "Claude output closed without a result",
                      new Error("unexpected end of output"),
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch((error) => channel.fail(error)),
      );
      yield* Effect.forkScoped(consume);

      const steer = Effect.fn("ClaudeChildBackend.steer")((message: string) =>
        Effect.logDebug("Steering Claude child session", {
          sessionId: request.session.id,
        }).pipe(
          Effect.andThen(
            Effect.try({
              try: () => input.offer(userMessage(message)),
              catch: (cause) => operationError("steer", request, "Could not steer Claude", cause),
            }),
          ),
        ),
      );
      const interrupt = Effect.logInfo("Interrupting Claude child session", {
        sessionId: request.session.id,
      }).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => query.interrupt(),
            catch: (cause) =>
              operationError("interrupt", request, "Could not interrupt Claude", cause),
          }),
        ),
        Effect.tap(() => Effect.sync(() => input.end())),
        Effect.asVoid,
      );
      return {
        session: request.session,
        events: Stream.fromQueue(channel.events),
        interrupt,
        result: Deferred.await(channel.result),
        steer,
        intervene: conversation.intervene,
      } satisfies RunningSession;
    },
  );
  return ChildBackend.of({ launch });
});

/** Provides `ChildBackend` with Claude Code for every delegated task. */
export const claudeChildLayer = Layer.effect(ChildBackend, makeClaudeChild);
/** Provides `ClaudeChildBackend` for direct use or harness-based dispatch. */
export const claudeChildBackendLayer = Layer.effect(ClaudeChildBackend, makeClaudeChild);
