import {
  type HookCallback,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { ModelId } from "@usine/core/agent/brain";
import {
  HarnessSession,
  HarnessSessionId,
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
  AgentResultError,
  ClaudeChildBackend,
  ClaudeLoginLock,
  ChildBackend,
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
import {
  apiRetryMessage,
  ClaudeApiRetry,
  ClaudeCompletionHeader,
  ClaudeResultMessage,
  decodeApiRetry,
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
  new SessionOperationError({
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
  const logins = yield* ClaudeLoginLock;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /**
   * Stops the Claude process of `request` on the remote `host` through its PID file, so that a
   * resumed launch is the only process in the session. Fails with `SessionOperationError` if the
   * Worker can't be reached or the stop fails.
   */
  const stopRemote = Effect.fn("ClaudeChildBackend.stopRemote")(function* (
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
  const holdLogin = Effect.fn("ClaudeChildBackend.holdLogin")(function* (request: ChildRequest) {
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
   * Launches Claude Code once for `request` and sends `messages`, keeping its Claude login lock
   * until the first messages decide the login state. With no messages, the launch waits for input
   * and skips the login check. Resources are added to the current scope.
   */
  const launchOnce = Effect.fn("ClaudeChildBackend.launchOnce")(function* (
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
        return yield* new UnknownModelError({
          harness: "claude",
          model: request.session.brain.model,
          message: `Claude has no model "${request.session.brain.model}"`,
        });
      }
      for (const message of messages) input.offer(userMessage(message));
      const read: Array<Schema.Json> = [];
      const login =
        messages.length === 0
          ? ("undecided" as const)
          : Option.getOrElse(
              yield* checkLogin(output, read).pipe(Effect.timeoutOption(LOGIN_WINDOW)),
              () => "undecided" as const,
            );
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
  const launchWithRetries = Effect.fn("ClaudeChildBackend.launchWithRetries")(function* (
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
      const options: ClaudeQueryOptions = {
        ...optionsFor(request),
        hooks: {
          PreToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
          PostToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
        },
      };
      // The launch that runs the session; a resume replaces it.
      let current = yield* launchWithRetries(request, options, [request.prompt], scope);

      const channel = yield* sessionChannel({
        label: "Claude child session",
        sessionId: request.session.id,
      });
      channel.onTerminal(() => {
        current.input.end();
      });
      const conversation = yield* sessionConversation({
        session: request.session,
        channel,
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
      const usage = claudeSessionMeter();
      // The latest session ID from Claude, which a resume loads.
      let harnessSessionId = Option.none<HarnessSessionId>();
      // Resumes since Claude last sent a message.
      let resumes = 0;
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

      /** Applies one message from Claude to the session. */
      const handle = (message: Schema.Json) =>
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
          if (Option.isSome(init)) harnessSessionId = Option.some(init.value.session_id);
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
          const used = usage.read(message);
          if (Option.isSome(used))
            yield* channel.emit(
              new SessionTokensUpdated({ session: request.session, ...used.value }),
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
      const resume = Effect.fn("ClaudeChildBackend.resume")(function* (
        broken: ClaudeLaunch,
        error: SessionOperationError,
      ) {
        yield* Effect.annotateCurrentSpan({
          sessionId: request.session.id,
          worker: request.worker,
        });
        const fields = {
          sessionId: request.session.id,
          parentSessionId: request.session.parentId,
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
            new ToolFinished({
              session: request.session,
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
          if (yield* channel.isTerminal) return Option.none<ClaudeLaunch>();
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
            Effect.map(Option.some),
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
          if (yield* channel.isTerminal) return;
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

      const steer = Effect.fn("ClaudeChildBackend.steer")((message: string) =>
        Effect.logDebug("Steering Claude child session", {
          sessionId: request.session.id,
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
        sessionId: request.session.id,
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
