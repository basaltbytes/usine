import { checkContinuationHome, environmentHome } from "../continuation.ts";
import { claudePreflight } from "./preflight.ts";
import { claude } from "./descriptor.ts";
import type { HarnessRuntime } from "../runtime.ts";
// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import {
  type HookCallback,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { Harness, ModelId } from "@usine/core/agent/brain";
import {
  ChildSession,
  HarnessSession,
  ProviderRecovered,
  ProviderRetries,
  ProviderRetrying,
  SessionStarted,
  SessionTokensUpdated,
  ToolFinished,
} from "@usine/core/agent/session";
import {
  type Cause,
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
import { ChildProcessSpawner } from "effect/process";
import {
  type AgentCapacityError,
  type AgentResultError,
  HostLoginLock,
  ChildBackend,
  ChildSessionLifecycle,
  type ChildRequest,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
} from "../../runtime.ts";
import {
  CHILD_STOP_SCRIPT,
  childPidFile,
  type RemoteShell,
  SSH_FAILURE,
  sshArguments,
} from "../../child-host/child-host.ts";
import { hostOutput } from "../../child-host/command.ts";
import { sessionChannel } from "../session.ts";
import { sessionConversation } from "../conversation.ts";
import { claudeSessionMeter, claudeTokenMeter } from "../usage.ts";
import { claudeRateLimits } from "./rate-limits.ts";
import {
  apiRetryMessage,
  ClaudeApiRetry,
  ClaudeCompletionHeader,
  ClaudeResultMessage,
  decodeApiRetry,
  apiRetryFailure,
  assistantFailure,
  resultFailure,
  decodeClaudeInit,
  decodeCompletionUpdate,
  isAssistantMessage,
  loginCheck,
  type LoginCheck,
  sessionEventsFrom,
} from "./codec.ts";
import {
  AsyncInput,
  ClaudeSdk,
  type ClaudeModelInfo,
  type ClaudeQuery,
  type ClaudeQueryOptions,
  userMessage,
} from "./sdk.ts";

export {
  ClaudeSdk,
  claudeSdkLive,
  type ClaudeModelInfo,
  type ClaudeQuery,
  type ClaudeQueryOptions,
  type ClaudeUserMessage,
} from "./sdk.ts";

const operationError = (
  operation: SessionOperationError["operation"],
  request: ChildRequest,
  message: string,
  cause: unknown,
): SessionOperationError =>
  SessionOperationError.make({
    operation,
    sessionId: Option.some(request.session.id),
    message,
    cause,
  });

/**
 * Returns a spawner that runs Claude Code on the remote host as one SSH command, with the SDK's
 * command, arguments, working directory, and environment in the remote command line. The abort
 * signal stops the SSH client; `onExit` gets its exit code, or `null` if a signal stopped it.
 */
const sshSpawner =
  (
    host: RemoteShell,
    pidFile: string,
    onStderr: (text: string) => void,
    onExit: (code: number | null) => void,
  ) =>
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
    child.once("exit", (code) => onExit(code));
    return child;
  };

/** Returns the options of every launch for `request`; each launch adds its remote spawner. */
const optionsFor = (request: ChildRequest): ClaudeQueryOptions => {
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
    ...Option.match(request.resume, {
      onNone: () => ({}),
      onSome: (saved) => ({ resume: saved.id }),
    }),
    // The worktree is untrusted, so its project and local settings (hooks, env) are not loaded into
    // a child that has the App credential; only the Worker user's settings apply.
    settingSources: ["user"],
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
 * The delays before each try to resume a remote child whose SSH connection broke, such as when the
 * orchestrator's machine slept. A message from Claude resets the count. When the delays run out,
 * the child fails with the broken connection's error (#603).
 */
const RESUME_DELAYS: ReadonlyArray<Duration.Duration> = [
  Duration.seconds(5),
  Duration.seconds(15),
  Duration.seconds(30),
  Duration.minutes(1),
  Duration.minutes(2),
  Duration.minutes(5),
];

/** The time a broken launch waits for its SSH client's exit code before it gives up resuming. */
const SSH_EXIT_WAIT = Duration.seconds(5);

/** The time limit for stopping a broken launch's Claude process on the Worker. */
const STOP_TIMEOUT = Duration.seconds(30);

/** The message that starts the next turn of a resumed child that was working. */
const RESUME_PROMPT =
  "usine lost its connection to this session and resumed it. Your last step may not have finished: check the worktree and any command you started before you go on. Then continue the task and end with your final answer. If the task is done, give your final answer again.";

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
  /**
   * Whether the launch's SSH client exited with `SSH_FAILURE`, which means that the connection to
   * the Worker broke, not Claude. Always `false` on a local host.
   */
  readonly lostConnection: Effect.Effect<boolean>;
  /** The scope of the launch's process, input, and output reader. */
  readonly scope: Scope.Closeable;
}

const makeClaudeChild = Effect.gen(function* () {
  const sdk = yield* ClaudeSdk;
  const logins = yield* HostLoginLock;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /**
   * Stops the Claude process of `request` on the remote `host` through its PID file, so that a
   * resumed launch is the only process in the session. Fails with `SessionOperationError` if the
   * Worker can't be reached or the stop fails.
   */
  const stopRemote = Effect.fn("ClaudeRuntime.stopRemote")(function* (
    request: ChildRequest,
    host: RemoteShell,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, worker: request.worker });
    const failed = (message: string, cause: unknown) =>
      operationError("launch", request, message, cause);
    const { stdout, exitCode } = yield* hostOutput(host, {
      environment: {},
      command: "sh",
      args: ["-c", CHILD_STOP_SCRIPT, "sh", childPidFile(request.cwd, request.session.id)],
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.timeout(STOP_TIMEOUT),
      Effect.mapError((cause) =>
        failed(`Can't stop the Claude child on ${host.destination}`, cause),
      ),
    );
    if (exitCode !== 0)
      return yield* failed(
        exitCode === SSH_FAILURE
          ? `Can't reach ${host.destination} to stop the Claude child`
          : `Stopping the Claude child on ${host.destination} exited with code ${exitCode}`,
        new Error(`exit code ${exitCode}`),
      );
    yield* Effect.logInfo("Stopped what was left of the Claude child on its Worker", {
      sessionId: request.session.id,
      worker: request.worker,
      outcome: stdout,
    });
  });

  /**
   * Acquires the request's Claude login lock in a fiber of the current scope and returns an effect
   * that releases it. The lock is also released after `LOGIN_WINDOW`, so a hung launch does not
   * block other Claude launches and preflights on that login.
   */
  const holdLogin = Effect.fn("ClaudeRuntime.holdLogin")(function* (request: ChildRequest) {
    const fields = {
      sessionId: request.session.id,
      worker: request.worker,
      ...Option.match(request.machine, { onNone: () => ({}), onSome: (machine) => ({ machine }) }),
    };
    yield* Effect.annotateCurrentSpan(fields);
    const held = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      logins.withLock(
        Harness.make("claude"),
        request.worker,
        request.machine,
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
      spentTokens ||= Option.exists(tokens(next.success), ({ totalTokens }) => totalTokens > 0);
      const check = loginCheck(next.success, spentTokens);
      if (check !== "waiting") return check;
    }
  });

  /**
   * Launches Claude Code once for `request` and sends `messages`, keeping its Claude login lock
   * until the first messages decide the login state. With no messages, the launch waits for input
   * and skips the login check. Resources are added to the current scope.
   */
  const launchOnce = Effect.fn("ClaudeRuntime.launchOnce")(function* (
    request: ChildRequest,
    options: ClaudeQueryOptions,
    messages: ReadonlyArray<string>,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, worker: request.worker });
    const context = yield* Effect.context<never>();
    const release = yield* holdLogin(request);
    return yield* Effect.gen(function* () {
      const input = new AsyncInput();
      const sshExit = yield* Deferred.make<number | null>();
      const query = sdk.open(
        input,
        request.host._tag === "RemoteShell"
          ? {
              ...options,
              spawnClaudeCodeProcess: sshSpawner(
                request.host,
                childPidFile(request.cwd, request.session.id),
                (text) => {
                  Effect.runForkWith(context)(
                    Effect.logDebug("Claude child stderr", {
                      sessionId: request.session.id,
                      text: text.trimEnd(),
                    }),
                  );
                },
                (code) => {
                  Deferred.doneUnsafe(sshExit, Exit.succeed(code));
                },
              ),
            }
          : // On a local host, the SDK spawns the process itself.
            options,
      );
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
        return yield* UnknownModelError.make({
          harness: Harness.make("claude"),
          model: request.session.brain.model,
          message: `Claude has no model "${request.session.brain.model}"`,
        });
      }
      for (const message of messages) input.offer(userMessage(message));
      const read: Array<Schema.Json> = [];
      const loginResult =
        messages.length === 0
          ? Option.none()
          : yield* checkLogin(output, read).pipe(Effect.timeoutOption(LOGIN_WINDOW));
      const login = Option.getOrElse(loginResult, () => "undecided" as const);
      yield* Effect.logDebug("Claude child's first messages settled its login check", {
        sessionId: request.session.id,
        worker: request.worker,
        login,
        messages: read.length,
      });
      const lostConnection =
        request.host._tag === "RemoteShell"
          ? Deferred.await(sshExit).pipe(
              Effect.timeoutOption(SSH_EXIT_WAIT),
              Effect.map((code) => Option.contains(code, SSH_FAILURE)),
            )
          : Effect.succeed(false);
      return { input, query, read, output, login, lostConnection } satisfies Omit<
        ClaudeLaunch,
        "scope"
      >;
    }).pipe(Effect.ensuring(release));
  });

  /**
   * Launches Claude Code for `request`, relaunching after each delay in `LOGIN_RETRY_DELAYS` while it
   * fails on the login refresh lock. Each launch has its own scope inside `scope`, closed before the
   * next or when the launch fails, so a failed launch's process and messages do not reach the
   * session. Returns the launch with its scope.
   */
  const launchWithRetries = Effect.fn("ClaudeRuntime.launchWithRetries")(function* (
    request: ChildRequest,
    options: ClaudeQueryOptions,
    messages: ReadonlyArray<string>,
    scope: Scope.Scope,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, worker: request.worker });
    for (let retry = 0; ; retry += 1) {
      const launchScope = yield* Scope.fork(scope);
      const opened: ClaudeLaunch = {
        ...(yield* launchOnce(request, options, messages).pipe(
          Scope.provide(launchScope),
          Effect.onError((cause) => Scope.close(launchScope, Exit.failCause(cause))),
        )),
        scope: launchScope,
      };
      if (opened.login !== "contended") {
        if (opened.login === "undecided")
          yield* Effect.logInfo("Claude child started without showing whether its login worked", {
            sessionId: request.session.id,
            worker: request.worker,
            messages: messages.length,
          });
        return opened;
      }
      const delay = LOGIN_RETRY_DELAYS[retry];
      if (delay === undefined) {
        yield* Effect.logWarning(
          "Claude child still could not refresh its Claude login; returning the error to the parent",
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
      yield* Effect.logInfo("Claude child could not refresh its Claude login; launching it again", {
        sessionId: request.session.id,
        parentSessionId: request.session.parentId,
        worker: request.worker,
        retry: retry + 1,
        maxRetries: LOGIN_RETRY_DELAYS.length,
        delay: Duration.format(delay),
      });
      yield* Effect.sleep(delay);
    }
  });

  const launch: ChildBackend["Service"]["launch"] = Effect.fn("ClaudeRuntime.launch")(
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
      const options: ClaudeQueryOptions = {
        ...optionsFor(request),
        hooks: {
          PreToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
          PostToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
        },
      };
      const { home, defaultHome } = environmentHome(
        request.environment,
        "CLAUDE_CONFIG_DIR",
        ".claude",
      );
      const lifecycle = yield* ChildSessionLifecycle.current;
      if (Option.isSome(request.resume) && request.host._tag === "RemoteShell")
        yield* stopRemote(request, request.host);
      yield* checkContinuationHome(request, home, defaultHome);
      // The launch that runs the session; a resume replaces it.
      let current = yield* launchWithRetries(
        request,
        options,
        request.paused || Option.isSome(request.idle) ? [] : [request.prompt],
        scope,
      );

      const usesApiKey = Option.isNone(request.session.gatewayCredential)
        ? yield* Effect.tryPromise({
            try: () => current.query.usesApiKey(),
            catch: (cause) =>
              operationError("launch", request, "Claude account discovery failed", cause),
          })
        : request.session.gatewayCredential.value === "api-key";
      const session = ChildSession.make({
        ...request.session,
        pool: Option.some(usesApiKey ? "apiKeys" : "claudePlan"),
      });
      yield* Effect.logInfo("Claude billing pool verified", {
        sessionId: session.id,
        pool: usesApiKey ? "apiKeys" : "claudePlan",
      });
      const channel = yield* sessionChannel({
        label: "Claude child session",
        sessionId: session.id,
      });
      channel.onTerminal(() => {
        current.input.end();
      });
      if (request.paused || Option.isSome(request.idle))
        yield* channel.emit(SessionStarted.make({ session, harnessSession: request.resume }));
      const conversation = yield* sessionConversation({
        session,
        channel,
        held: request.held,
        paused: request.paused,
        idle: request.idle,
        // A message sent during a turn is queued until a tool call returns or the turn ends.
        send: (message, activity) =>
          Effect.try({
            try: () => current.input.offer(userMessage(message)),
            catch: (cause) =>
              operationError("steer", request, "Can't send a message to Claude", cause),
          }).pipe(Effect.as(activity === "idle" ? ("read" as const) : ("queued" as const))),
        pause: Effect.void,
        beforeFinish: Effect.void,
      });
      boundary = conversation.awaitUnpaused;
      const tools = new Map<string, string>();
      const usage = claudeSessionMeter(Option.getOrUndefined(request.usage));
      const readRateLimits = claudeRateLimits(session);
      // The latest session ID from Claude, which a resume loads.
      let harnessSessionId = Option.map(request.resume, (saved) => saved.id);
      // Resumes since Claude last sent a message.
      let resumes = 0;
      let backgroundTasks: ReadonlyArray<string> = [];
      let reportsSessionState = false;
      let completedTurn = Option.none<string>();
      // Claude sends `init` with one session ID before each turn; the first is the launch record.
      const launched = yield* Ref.make(request.paused || Option.isSome(request.idle));
      // API retries reported in the current turn, and whether the last retry is unresolved.
      let retries = 0;
      let retrying = false;

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

      let providerFailure = Option.none<AgentCapacityError | AgentResultError>();

      /** Applies one message from Claude to the session. */
      const handle = (message: Schema.Json) =>
        Effect.gen(function* () {
          const limits = yield* readRateLimits(message);
          if (Option.isSome(limits)) yield* channel.emit(limits.value);
          const retry = decodeApiRetry(message);
          if (Option.isSome(retry)) {
            providerFailure = apiRetryFailure(session.id, retry.value);
            return yield* reportRetry(retry.value);
          }
          if (isAssistantMessage(message))
            providerFailure = assistantFailure(session.id, message, providerFailure);
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
                sessionId: session.id,
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
                    sessionId: session.id,
                    backgroundTaskIds: backgroundTasks,
                  });
              }
            }
            return;
          }
          const init = decodeClaudeInit(message);
          if (Option.isSome(init)) harnessSessionId = Option.some(init.value.session_id);
          if (Option.isSome(init) && !(yield* Ref.getAndSet(launched, true))) {
            const harnessSession = HarnessSession.make({
              id: init.value.session_id,
              cwd: request.cwd,
              home,
            });
            yield* channel.emit(
              SessionStarted.make({
                session,
                harnessSession: Option.some(harnessSession),
              }),
            );
            yield* Effect.logInfo("Claude child session saved", {
              sessionId: session.id,
              parentSessionId: session.parentId,
              harnessSessionId: harnessSession.id,
              cwd: harnessSession.cwd,
            });
          }
          const used = usage.read(message);
          if (Option.isSome(used))
            yield* channel.emit(SessionTokensUpdated.make({ session, ...used.value }));
          for (const event of sessionEventsFrom(message, session, tools)) {
            yield* channel.emit(event);
          }
          if (!Schema.is(ClaudeResultMessage)(message)) return;
          completedTurn = Option.none();
          retries = 0;
          retrying = false;
          if (message.subtype !== "success" || message.result === undefined) {
            yield* channel.fail(resultFailure(session.id, message, providerFailure));
            return;
          }
          providerFailure = Option.none();
          const stillQueued = message.queued_turn_count;
          // Claude has read every queued message except those still queued as separate turns.
          if (stillQueued !== undefined)
            yield* conversation.read((queued) => queued.length - stillQueued);
          if (message.queued_turn_count !== undefined && message.queued_turn_count > 0) {
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
            yield* Effect.logInfo("Claude child is waiting for background work", {
              sessionId: session.id,
              backgroundTaskIds: backgroundTasks,
            });
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
            Stream.catch(
              (error): Stream.Stream<Result.Result<Schema.Json, SessionOperationError>> =>
                Stream.make(Result.fail(error)),
            ),
            Stream.runForEach(
              Result.match({
                onSuccess: (message) =>
                  Effect.suspend(() => {
                    resumes = 0;
                    return handle(message);
                  }),
                onFailure: (error) =>
                  Effect.sync(() => {
                    broken = Option.some(error);
                  }),
              }),
            ),
          );
          return broken;
        });

      /**
       * Resumes the session in a new launch after `broken` lost its SSH connection to the Worker:
       * stops what is left of its Claude process there, then launches Claude with the saved session,
       * retrying after each delay in `RESUME_DELAYS`. Returns `None` if the session can't be resumed.
       */
      const resume = Effect.fn("ClaudeRuntime.resume")(function* (
        broken: ClaudeLaunch,
        error: SessionOperationError,
      ) {
        yield* Effect.annotateCurrentSpan({
          sessionId: session.id,
          worker: request.worker,
        });
        const fields = {
          sessionId: session.id,
          parentSessionId: session.parentId,
          worker: request.worker,
        };
        const notResumed = (reason: string) =>
          Effect.logInfo("Not resuming the Claude child after its output ended", {
            ...fields,
            reason,
            message: error.message,
          }).pipe(Effect.as(Option.none<ClaudeLaunch>()));
        const host = request.host;
        const harnessSession = harnessSessionId;
        if (yield* lifecycle.isStopping) return yield* notResumed("its attempt is stopping");
        if (host._tag !== "RemoteShell") return yield* notResumed("it runs on this machine");
        if (Option.isNone(harnessSession)) return yield* notResumed("Claude saved no session");
        if (!(yield* broken.lostConnection))
          return yield* notResumed("its SSH connection didn't break");
        yield* Effect.logWarning(
          "Claude child lost its SSH connection to the Worker; resuming its session",
          { ...fields, harnessSessionId: harnessSession.value, message: error.message },
        );
        yield* Scope.close(broken.scope, Exit.void);
        // The broken launch's process took its background work and open tool calls with it.
        backgroundTasks = [];
        completedTurn = Option.none();
        for (const [callId, tool] of tools)
          yield* channel.emit(
            ToolFinished.make({
              session,
              callId,
              tool,
              output: "usine lost its connection to the Worker before this call returned",
              isError: true,
            }),
          );
        tools.clear();
        usage.restart();
        for (;;) {
          const delay = RESUME_DELAYS[resumes];
          if (delay === undefined) {
            yield* Effect.logWarning("Could not resume the Claude child; it fails", {
              ...fields,
              tries: resumes,
            });
            return Option.none<ClaudeLaunch>();
          }
          resumes += 1;
          yield* Effect.logInfo("Resuming the Claude child after a pause", {
            ...fields,
            try: resumes,
            maxTries: RESUME_DELAYS.length,
            delay: Duration.format(delay),
          });
          yield* Effect.sleep(delay);
          if ((yield* lifecycle.isStopping) || (yield* channel.isTerminal))
            return Option.none<ClaudeLaunch>();
          // A paused or idle child waits for the operator, so only a working child gets a turn.
          const working = !((yield* conversation.isPaused) || (yield* conversation.isIdle));
          const messages = [...(working ? [RESUME_PROMPT] : []), ...(yield* conversation.unread)];
          const resumed = yield* stopRemote(request, host).pipe(
            Effect.andThen(
              launchWithRetries(
                request,
                { ...options, resume: harnessSession.value },
                messages,
                scope,
              ),
            ),
            Effect.asSome,
            Effect.catchTag("SessionOperationError", (failure) =>
              Effect.logWarning("Could not resume the Claude child yet", {
                ...fields,
                try: resumes,
                message: failure.message,
              }).pipe(Effect.as(Option.none<ClaudeLaunch>())),
            ),
          );
          if (Option.isSome(resumed)) {
            yield* Effect.logInfo("Resumed the Claude child's session", {
              ...fields,
              harnessSessionId: harnessSession.value,
              working,
              messages: messages.length,
            });
            return resumed;
          }
        }
      });

      const consume = Effect.gen(function* () {
        for (;;) {
          const broken = yield* drain(current);
          if ((yield* lifecycle.isStopping) || (yield* channel.isTerminal)) return;
          const error = Option.getOrElse(broken, () =>
            operationError(
              "stream",
              request,
              "Claude output closed without a result",
              new Error("unexpected end of output"),
            ),
          );
          const resumed = yield* resume(current, error);
          if (Option.isNone(resumed)) return yield* channel.fail(error);
          current = resumed.value;
        }
      }).pipe(Effect.catch((error) => channel.fail(error)));
      yield* Effect.forkScoped(consume);

      const steer = Effect.fn("ClaudeRuntime.steer")((message: string) =>
        Effect.logDebug("Steering Claude child session", {
          sessionId: session.id,
        }).pipe(
          Effect.andThen(
            Effect.try({
              try: () => current.input.offer(userMessage(message)),
              catch: (cause) => operationError("steer", request, "Can't steer Claude", cause),
            }),
          ),
        ),
      );
      const interrupt = Effect.logInfo("Interrupting Claude child session", {
        sessionId: session.id,
      }).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => current.query.interrupt(),
            catch: (cause) => operationError("interrupt", request, "Can't interrupt Claude", cause),
          }),
        ),
        Effect.tap(() => Effect.sync(() => current.input.end())),
        Effect.asVoid,
      );
      return {
        session,
        events: Stream.fromQueue(channel.events),
        interrupt,
        result: Deferred.await(channel.result),
        steer,
        intervene: conversation.intervene,
      } satisfies RunningSession;
    },
  );
  const stop = Effect.fn("ClaudeRuntime.stop")(function* (request: ChildRequest) {
    if (request.host._tag === "RemoteShell") yield* stopRemote(request, request.host);
  });
  return ChildBackend.of({ launch, stop });
});

/** Provides `ChildBackend` with Claude Code for every delegated task. */
export const claudeChildLayer = Layer.effect(ChildBackend, makeClaudeChild);

/** Combines preflight and scoped launch for registration. */
export const claudeRuntime = Effect.gen(function* () {
  const child = yield* makeClaudeChild;
  const preflight = yield* claudePreflight;
  return {
    id: claude.id,
    preflight,
    launch: child.launch,
    stop: child.stop,
  } satisfies HarnessRuntime;
});
