import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { AgentSessionId } from "@usine/core/agent/session";
import { type ChildHost, childPidFile } from "../../child-host/child-host.ts";
import { hostCommand } from "../../child-host/command.ts";
import { type WorkingDirectory, SessionOperationError } from "../../runtime.ts";

/** The settings of one app-server connection. */
export interface CodexClient {
  /** The checkout directory on `host`. */
  readonly cwd: WorkingDirectory;
  /** `None` during preflight, before a child session exists. */
  readonly sessionId: Option.Option<AgentSessionId>;
  /**
   * The complete environment of the app server and its commands on a local host, or the variables
   * exported on top of a remote host's environment.
   */
  readonly environment: Readonly<Record<string, string>>;
  readonly host: ChildHost;
}

export interface CodexNotification {
  readonly method: string;
  readonly params: Schema.Json;
}

/** A JSON-RPC connection to the app server, scoped to its process. */
export interface CodexConnection {
  /** Closes stdin and waits for the app server to shut down its threads and commands. */
  readonly close: Effect.Effect<void, SessionOperationError>;
  readonly notifications: Stream.Stream<CodexNotification, SessionOperationError>;
  readonly request: (
    operation: SessionOperationError["operation"],
    method: string,
    params: Schema.Json,
  ) => Effect.Effect<Schema.Json, SessionOperationError>;
  readonly notify: (
    operation: SessionOperationError["operation"],
    method: string,
    params: Schema.Json,
  ) => Effect.Effect<void, SessionOperationError>;
}

/** The service that spawns the Codex app-server process and provides its JSON-RPC connection. */
export class CodexAppServer extends Context.Service<
  CodexAppServer,
  {
    readonly open: (
      request: CodexClient,
    ) => Effect.Effect<CodexConnection, SessionOperationError, Scope.Scope>;
  }
>()("@usine/agents/pi/CodexAppServer") {}

const RpcSuccessResponse = Schema.Struct({
  id: Schema.Int,
  result: Schema.Json,
});
const RpcErrorResponse = Schema.Struct({
  id: Schema.Int,
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    data: Schema.optionalKey(Schema.Json),
  }),
});
const RpcResponse = Schema.Union([RpcSuccessResponse, RpcErrorResponse]);
const RpcMessage = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
});
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const encoder = new TextEncoder();

const RPC_TIMEOUT = "60 seconds";
const STDERR_TAIL_LINES = 5;
const preview = (line: string): string => (line.length > 200 ? `${line.slice(0, 200)}…` : line);

export const operationError = (
  operation: SessionOperationError["operation"],
  request: CodexClient,
  message: string,
  cause: unknown,
): SessionOperationError =>
  new SessionOperationError({
    operation,
    sessionId: request.sessionId,
    message,
    cause,
  });

interface PendingRequest {
  readonly operation: SessionOperationError["operation"];
  readonly response: Deferred.Deferred<Schema.Json, SessionOperationError>;
}

const repositoryTrustOverride = (cwd: string): string =>
  `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`;
const disableRecursiveAgentsOverride = "features.multi_agent=false";

/**
 * Returns the app-server command for `client` on its host. The process starts in the home directory,
 * not the worktree, so startup cannot read repository config before thread trust is set.
 */
export const codexAppServerCommand = (
  client: CodexClient,
  stdin?: ChildProcess.CommandOptions["stdin"],
): ChildProcess.Command => {
  const lifetime: ChildProcess.CommandOptions = {
    // Not detached, so killing the launching process group also kills the app server; SIGTERM is
    // followed by SIGKILL after 5 seconds (ADR 0006).
    detached: false,
    forceKillAfter: "5 seconds",
  };
  return hostCommand(
    client.host,
    {
      environment: client.environment,
      pidFile: Option.getOrUndefined(
        Option.map(client.sessionId, (sessionId) => childPidFile(client.cwd, sessionId)),
      ),
      command: "codex",
      args: [
        "app-server",
        "--stdio",
        "-c",
        repositoryTrustOverride(client.cwd),
        "-c",
        disableRecursiveAgentsOverride,
      ],
    },
    stdin === undefined ? lifetime : { ...lifetime, stdin },
  );
};

const makeCodexAppServer = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const open: CodexAppServer["Service"]["open"] = Effect.fn("CodexAppServer.open")(
    function* (request) {
      yield* Effect.annotateCurrentSpan({
        harness: "codex",
        sessionId: Option.getOrUndefined(request.sessionId),
      });
      const input = yield* Queue.make<Uint8Array, Cause.Done>();
      const notifications = yield* Queue.make<
        CodexNotification,
        SessionOperationError | Cause.Done
      >();
      const pending = yield* Ref.make(new Map<number, PendingRequest>());
      const nextId = yield* Ref.make(1);
      const closing = yield* Ref.make(false);
      const failure = yield* Ref.make(Option.none<SessionOperationError>());
      const stderrTail = yield* Ref.make<ReadonlyArray<string>>([]);
      const handle = yield* spawner
        .spawn(
          codexAppServerCommand(request, {
            stream: Stream.fromQueue(input),
            endOnDone: true,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            operationError("launch", request, "Codex app-server failed to start", cause),
          ),
        );

      const write = (message: Schema.Json, operation: SessionOperationError["operation"]) =>
        Queue.offer(input, encoder.encode(`${JSON.stringify(message)}\n`)).pipe(
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : Effect.fail(
                  operationError(
                    operation,
                    request,
                    "Codex app-server input is closed",
                    new Error("input queue closed"),
                  ),
                ),
          ),
          Effect.mapError((cause) =>
            cause instanceof SessionOperationError
              ? cause
              : operationError(operation, request, "Can't write to Codex app-server", cause),
          ),
        );

      const failAll = Effect.fn("CodexAppServer.failAll")(function* (error: SessionOperationError) {
        yield* Ref.update(
          failure,
          Option.orElseSome(() => error),
        );
        const waiting = yield* Ref.getAndSet(pending, new Map());
        for (const entry of waiting.values()) yield* Deferred.fail(entry.response, error);
        yield* Queue.fail(notifications, error);
      });

      // Handles one stdout line, without a span. Unrecognized input is logged and skipped, so a
      // stray frame does not fail the session and cause an infra retry (ADR 0002).
      const routeLine = (line: string) =>
        Effect.gen(function* () {
          if (line.trim().length === 0) return;
          const decoded = yield* decodeLine(line).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Skipping a non-JSON Codex app-server line", {
                cause,
                line: preview(line),
                sessionId: Option.getOrUndefined(request.sessionId),
              }).pipe(Effect.as(undefined)),
            ),
          );
          if (decoded === undefined) return;
          if (Schema.is(RpcResponse)(decoded)) {
            const found = yield* Ref.modify(pending, (entries) => {
              const entry = entries.get(decoded.id);
              if (entry === undefined) return [Option.none<PendingRequest>(), entries];
              const updated = new Map(entries);
              updated.delete(decoded.id);
              return [Option.some(entry), updated];
            });
            if (Option.isNone(found)) {
              return yield* Effect.logDebug("Ignoring a Codex response with no waiting request", {
                id: decoded.id,
                sessionId: Option.getOrUndefined(request.sessionId),
              });
            }
            if (Schema.is(RpcErrorResponse)(decoded)) {
              return yield* Deferred.fail(
                found.value.response,
                operationError(
                  found.value.operation,
                  request,
                  `Codex app-server returned an error: ${decoded.error.message}`,
                  decoded.error,
                ),
              );
            }
            return yield* Deferred.succeed(found.value.response, decoded.result);
          }
          if (!Schema.is(RpcMessage)(decoded)) {
            return yield* Effect.logWarning("Skipping an unknown Codex JSON-RPC shape", {
              line: preview(line),
              sessionId: Option.getOrUndefined(request.sessionId),
            });
          }
          if (decoded.id !== undefined) {
            yield* Effect.logWarning("Codex app-server requested unsupported client input", {
              method: decoded.method,
              sessionId: Option.getOrUndefined(request.sessionId),
            });
            return yield* write(
              {
                id: decoded.id,
                error: { code: -32601, message: "usine runs Codex headlessly" },
              },
              "stream",
            );
          }
          yield* Queue.offer(notifications, {
            method: decoded.method,
            params: decoded.params ?? null,
          });
        });

      const stdoutReader = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(routeLine),
        Effect.flatMap(() =>
          Ref.get(closing).pipe(
            Effect.flatMap((closed) =>
              closed
                ? Effect.void
                : handle.exitCode.pipe(
                    // If the process exits within 5 seconds, its exit monitor reports the error;
                    // otherwise a running process that closed stdout fails here.
                    Effect.timeout("5 seconds"),
                    Effect.matchEffect({
                      onSuccess: () => Effect.void,
                      onFailure: (cause) =>
                        failAll(
                          operationError(
                            "stream",
                            request,
                            "Codex app-server output closed unexpectedly",
                            cause,
                          ),
                        ),
                    }),
                  ),
            ),
          ),
        ),
        Effect.catch((error) =>
          failAll(
            error instanceof SessionOperationError
              ? error
              : operationError("stream", request, "Can't read Codex app-server output", error),
          ),
        ),
        Effect.forkScoped,
      );
      const stderrReader = yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          line.trim().length === 0
            ? Effect.void
            : Effect.logDebug("Codex app-server stderr", {
                line: preview(line),
                sessionId: Option.getOrUndefined(request.sessionId),
              }).pipe(
                Effect.andThen(
                  Ref.update(stderrTail, (tail) => [...tail, line].slice(-STDERR_TAIL_LINES)),
                ),
              ),
        ),
        Effect.catch((cause) =>
          failAll(
            operationError("stream", request, "Can't read Codex app-server diagnostics", cause),
          ),
        ),
        Effect.forkScoped,
      );
      yield* handle.exitCode.pipe(
        Effect.flatMap((exitCode) =>
          Effect.all([Ref.get(closing), Ref.get(stderrTail)]).pipe(
            Effect.flatMap(([closed, stderr]) =>
              closed
                ? Effect.void
                : failAll(
                    operationError(
                      "stream",
                      request,
                      `Codex app-server exited with code ${String(exitCode)}`,
                      { exitCode, stderr },
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch((cause) =>
          failAll(operationError("stream", request, "Can't monitor Codex app-server", cause)),
        ),
        Effect.forkScoped,
      );
      // Closing stdin runs Codex's thread shutdown, including background commands; SIGTERM skips it
      // in stdio mode. One bounded shutdown is shared by terminal delivery and scope release, and
      // it runs even if the caller is interrupted.
      const rejectPending = (cause: unknown) =>
        Effect.gen(function* () {
          const waiting = yield* Ref.getAndSet(pending, new Map());
          for (const entry of waiting.values())
            yield* Deferred.fail(
              entry.response,
              operationError(
                entry.operation,
                request,
                "Codex app-server closed before it responded to the request",
                cause,
              ),
            );
        });
      const close = yield* Effect.cached(
        Effect.fn("CodexAppServer.close")(function* () {
          yield* Effect.annotateCurrentSpan({
            sessionId: Option.getOrUndefined(request.sessionId),
          });
          yield* Ref.set(closing, true);
          yield* Queue.end(input);
          const [exitCode] = yield* Effect.all(
            [handle.exitCode, Fiber.join(stdoutReader), Fiber.join(stderrReader)],
            {
              concurrency: "unbounded",
            },
          ).pipe(
            Effect.timeout("15 seconds"),
            Effect.mapError((cause) =>
              operationError(
                "interrupt",
                request,
                "Codex app-server didn't shut down cleanly",
                cause,
              ),
            ),
            Effect.tapError(rejectPending),
          );
          yield* rejectPending({ exitCode });
          if (exitCode !== 0)
            return yield* operationError(
              "interrupt",
              request,
              `Codex app-server exited with code ${String(exitCode)} during shutdown`,
              { exitCode, stderr: yield* Ref.get(stderrTail) },
            );
          yield* Queue.end(notifications);
          yield* Effect.logDebug("Codex app-server shutdown completed", { exitCode });
        })().pipe(Effect.tapError(failAll), Effect.uninterruptible),
      );
      yield* Effect.addFinalizer(() =>
        close.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Forcing Codex app-server to stop after graceful shutdown failed", {
              cause,
              sessionId: Option.getOrUndefined(request.sessionId),
            }).pipe(
              Effect.andThen(handle.kill({ forceKillAfter: "5 seconds" })),
              Effect.catch((cause) =>
                Effect.logWarning("Could not force Codex app-server to stop", {
                  cause,
                  sessionId: Option.getOrUndefined(request.sessionId),
                }),
              ),
            ),
          ),
        ),
      );

      const requestRpc: CodexConnection["request"] = (operation, method, params) =>
        Effect.gen(function* () {
          if (yield* Ref.get(closing))
            return yield* operationError(
              operation,
              request,
              "Codex app-server connection is closing",
              new Error("connection closed"),
            );
          const failed = yield* Ref.get(failure);
          if (Option.isSome(failed)) {
            return yield* operationError(
              operation,
              request,
              "Codex app-server connection already failed",
              failed.value,
            );
          }
          const id = yield* Ref.getAndUpdate(nextId, (current) => current + 1);
          const response = yield* Deferred.make<Schema.Json, SessionOperationError>();
          yield* Ref.update(pending, (entries) =>
            new Map(entries).set(id, { operation, response }),
          );
          const forget = Ref.update(pending, (entries) => {
            const updated = new Map(entries);
            updated.delete(id);
            return updated;
          });
          yield* write({ id, method, params }, operation).pipe(Effect.tapError(() => forget));
          return yield* Deferred.await(response).pipe(
            Effect.timeoutOrElse({
              duration: RPC_TIMEOUT,
              orElse: () =>
                forget.pipe(
                  Effect.andThen(
                    operationError(
                      operation,
                      request,
                      `Codex app-server didn't respond to ${method} within ${RPC_TIMEOUT}`,
                      new Error("request timed out"),
                    ),
                  ),
                ),
            }),
          );
        });
      const notify: CodexConnection["notify"] = (operation, method, params) =>
        write({ method, params }, operation);
      return {
        close,
        notifications: Stream.fromQueue(notifications),
        request: requestRpc,
        notify,
      } satisfies CodexConnection;
    },
  );
  return CodexAppServer.of({ open });
});

export const codexAppServerLive = Layer.effect(CodexAppServer, makeCodexAppServer);
