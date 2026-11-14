import { Harness } from "@usine/core/agent/brain";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import type { HostInput } from "../../child-host/child-host.ts";
import { startChildProcess, childProcessCommand } from "../../child-host/node.ts";
import { boundedLines } from "../../child-host/lines.ts";
import { processError, stopChildProcess } from "../../child-host/process.ts";
import { ChildSessionLifecycle, SessionOperationError } from "../../runtime.ts";

import {
  CodexAppServer,
  type CodexClient,
  type CodexConnection,
  type CodexNotification,
  operationError,
} from "./connection.ts";

export {
  CodexAppServer,
  type CodexClient,
  type CodexConnection,
  type CodexNotification,
  operationError,
} from "./connection.ts";

const RpcSuccessResponse = Schema.Struct({
  id: Schema.Union([Schema.Int, Schema.String]),
  result: Schema.Json,
});
const RpcErrorResponse = Schema.Struct({
  id: Schema.Union([Schema.Int, Schema.String]),
  error: Schema.Struct({
    code: Schema.Finite,
    message: Schema.String,
    data: Schema.optionalKey(Schema.Json),
  }),
});
const RpcResponse = Schema.Union([RpcSuccessResponse, RpcErrorResponse]);
const RpcMessage = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
  id: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
});
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const encoder = new TextEncoder();

const RPC_TIMEOUT = "60 seconds";
const EXIT_REPORT_GRACE = "1 second";
const preview = (line: string): string => (line.length > 200 ? `${line.slice(0, 200)}…` : line);

interface PendingRequest {
  readonly operation: SessionOperationError["operation"];
  readonly response: Deferred.Deferred<Schema.Json, SessionOperationError>;
}

// codexAppServerCommand returns a command synchronously, including its quoted TOML key.
// @effect-diagnostics-next-line schemaSync:off
const quoteDirectory = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const repositoryTrustOverride = (cwd: string): string =>
  `projects={${quoteDirectory(cwd)}={trust_level="untrusted"}}`;
/** Command-line overrides for every Codex invocation: disable nested agents, plugins, apps, startup update checks, and analytics. */
export const codexConfigArgs: ReadonlyArray<string> = [
  "features.multi_agent=false",
  "features.plugins=false",
  "features.remote_plugin=false",
  "features.apps=false",
  "check_for_update_on_startup=false",
  "analytics.enabled=false",
].flatMap((override) => ["-c", override]);

const appServerArgs = (cwd: string) => [
  "app-server",
  "--stdio",
  "-c",
  repositoryTrustOverride(cwd),
  ...codexConfigArgs,
];

/**
 * Returns the app-server command for `client` on its host. The process starts in `/`,
 * not the worktree, so startup cannot read repository config before thread trust is set.
 * Throws if `client`'s host is an `ExecShell`, which has no local command, or a remote host with
 * a non-empty environment.
 */
export const codexAppServerCommand = (
  client: CodexClient,
  stdin?: HostInput,
): ChildProcess.Command =>
  childProcessCommand(
    client,
    {
      cwd: "/",
      command: "codex",
      args: [
        ...appServerArgs(client.cwd),
        ...(client.host._tag === "LocalProcess" ? ["-c", 'cli_auth_credentials_store="file"'] : []),
      ],
    },
    stdin,
  );

const makeCodexAppServer = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const open: CodexAppServer["Service"]["open"] = Effect.fn("CodexAppServer.open")(
    function* (request) {
      yield* Effect.annotateCurrentSpan({
        harness: Harness.make("codex"),
        sessionId: Option.getOrUndefined(request.sessionId),
      });
      const lifecycle = yield* ChildSessionLifecycle.current;
      const input = yield* Queue.make<Uint8Array, Cause.Done>();
      const notifications = yield* Queue.make<
        CodexNotification,
        SessionOperationError | Cause.Done
      >();
      const pending = yield* Ref.make(new Map<number | string, PendingRequest>());
      const nextId = yield* Ref.make(1);
      const closing = yield* Ref.make(false);
      const failure = yield* Ref.make(Option.none<SessionOperationError>());
      // Created before the process starts, so its fibers stop after the shutdown in `close`.
      const answers = yield* FiberSet.make();
      const handle = yield* startChildProcess(
        request,
        {
          cwd: "/",
          command: "codex",
          args: [
            ...appServerArgs(request.cwd),
            ...(request.host._tag === "LocalProcess"
              ? ["-c", 'cli_auth_credentials_store="file"']
              : []),
          ],
        },
        Stream.fromQueue(input),
        { transport: request.transport },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) =>
          operationError("launch", request, "Codex app-server failed to start", cause),
        ),
      );

      const write = (message: Schema.Json, operation: SessionOperationError["operation"]) =>
        Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(message).pipe(
          Effect.orDie,
          Effect.flatMap((line) => Queue.offer(input, encoder.encode(`${line}\n`))),
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
            Schema.is(SessionOperationError)(cause)
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
            const id = decoded.id;
            const answer = Option.flatMap(Option.fromUndefinedOr(request.serve), (serve) =>
              serve({ method: decoded.method, params: decoded.params ?? null }),
            );
            if (Option.isSome(answer))
              return yield* FiberSet.run(
                answers,
                answer.value.pipe(
                  Effect.flatMap((result) => write({ id, result }, "stream")),
                  Effect.catch((cause) =>
                    Effect.logWarning("Can't answer a Codex app-server request", {
                      cause,
                      method: decoded.method,
                      sessionId: Option.getOrUndefined(request.sessionId),
                    }),
                  ),
                ),
              );
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

      const lines =
        request.protocolFrameMib === undefined
          ? handle.stdout.pipe(Stream.decodeText(), Stream.splitLines)
          : boundedLines(
              handle.stdout,
              () =>
                operationError(
                  "stream",
                  request,
                  `Codex app-server frame exceeds ${request.protocolFrameMib} MiB`,
                  { limitMib: request.protocolFrameMib },
                ),
              "emit",
              request.protocolFrameMib * 1024 ** 2,
            );
      const stdoutReader = yield* lines.pipe(
        Stream.runForEach(routeLine),
        Effect.flatMap(() =>
          Ref.get(closing).pipe(
            Effect.flatMap((closed) =>
              closed
                ? Effect.void
                : handle.exit.pipe(
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
        Effect.tapError((error) =>
          Effect.logWarning("Codex app-server output failed", {
            sessionId: Option.getOrUndefined(request.sessionId),
            message: error.message,
          }),
        ),
        Effect.catch((error) =>
          failAll(
            Schema.is(SessionOperationError)(error)
              ? error
              : operationError("stream", request, "Can't read Codex app-server output", error),
          ),
        ),
        Effect.forkScoped,
      );
      yield* handle.exit.pipe(
        Effect.tap(() => Fiber.join(stdoutReader)),
        Effect.flatMap((event) =>
          Ref.get(closing).pipe(
            Effect.flatMap((closed) =>
              closed
                ? Effect.void
                : failAll(
                    processError(
                      request,
                      `Child process exited with code ${event.exitCode}`,
                      event,
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch(failAll),
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
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            sessionId: Option.getOrUndefined(request.sessionId),
          });
          yield* Ref.set(closing, true);
          if (yield* lifecycle.isStopping) return;
          yield* Queue.end(input);
          const [event] = yield* Effect.all([handle.exit, Fiber.join(stdoutReader)], {
            concurrency: "unbounded",
          }).pipe(
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
          const { exitCode, stderrTail } = event;
          yield* rejectPending(event);
          if (exitCode !== 0)
            return yield* operationError(
              "interrupt",
              request,
              `Codex app-server exited with code ${String(exitCode)} during shutdown`,
              { exitCode, stderrTail },
            );
          yield* Queue.end(notifications);
          yield* Effect.logDebug("Codex app-server shutdown completed", { exitCode });
        }).pipe(
          Effect.withSpan("CodexAppServer.close"),
          Effect.tapError(failAll),
          Effect.uninterruptible,
        ),
      );
      // The exit code once the app-server's exit is reported, waiting at most `grace`; none while
      // it runs or when its exit monitor failed.
      const exitedWithin = (grace: Duration.Input) =>
        handle.exit.pipe(
          Effect.timeoutOption(grace),
          Effect.map(Option.map(({ exitCode }) => exitCode)),
          Effect.orElseSucceed(() => Option.none<number>()),
        );
      const forceStop = Effect.fn("CodexAppServer.forceStop")(function* (cause: unknown) {
        const sessionId = Option.getOrUndefined(request.sessionId);
        yield* Effect.annotateCurrentSpan({ sessionId });
        const exited = yield* exitedWithin(Duration.zero);
        if (Option.isSome(exited))
          yield* Effect.logDebug(
            "Stopping Codex app-server after it exited during a failed graceful shutdown",
            { cause, exitCode: exited.value, sessionId },
          );
        else
          yield* Effect.logWarning(
            "Forcing Codex app-server to stop after graceful shutdown failed",
            { cause, sessionId },
          );
        yield* handle.kill().pipe(
          Effect.catch((cause) =>
            // A kill fails when the process is already gone; its exit report may trail the kill.
            Effect.flatMap(exitedWithin(EXIT_REPORT_GRACE), (exited) =>
              Option.isSome(exited)
                ? Effect.logDebug("Codex app-server had already exited before the forced stop", {
                    cause,
                    exitCode: exited.value,
                    sessionId,
                  })
                : Effect.logWarning("Could not force Codex app-server to stop", {
                    cause,
                    sessionId,
                  }),
            ),
          ),
        );
      });
      yield* Effect.addFinalizer(() =>
        close.pipe(
          Effect.catch((cause) =>
            Effect.flatMap(lifecycle.isStopping, (stopping) =>
              stopping ? Effect.void : forceStop(cause),
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
          if (Option.isSome(failed)) return yield* failed.value;
          const generation = yield* handle.generation;
          const sequence = yield* Ref.getAndUpdate(nextId, (current) => current + 1);
          const id = Option.match(generation, {
            onNone: () => sequence,
            onSome: (epoch) => `${epoch}:${sequence}`,
          });
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
  const stop: CodexAppServer["Service"]["stop"] = (target) =>
    stopChildProcess(target).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  return CodexAppServer.of({ open, stop });
});

/** Provides `CodexAppServer` over process standard streams using `ChildProcessSpawner`. Scope cleanup closes stdin and force-stops the process if graceful shutdown fails. */
export const codexAppServerLive = Layer.effect(CodexAppServer, makeCodexAppServer);
