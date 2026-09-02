import {
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { homedir } from "node:os";
import { type ChildRequest, SessionOperationError } from "../../runtime.ts";

export interface CodexNotification {
  readonly method: string;
  readonly params: Schema.Json;
}

/** One scoped JSON-RPC app-server connection, narrow enough to script in tests. */
export interface CodexConnection {
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

/** Process seam for the Codex app-server transport. */
export class CodexAppServer extends Context.Service<
  CodexAppServer,
  {
    readonly open: (
      request: ChildRequest,
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

interface PendingRequest {
  readonly operation: SessionOperationError["operation"];
  readonly response: Deferred.Deferred<Schema.Json, SessionOperationError>;
}

const repositoryTrustOverride = (cwd: string): string =>
  `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`;
const disableRecursiveAgentsOverride = "features.multi_agent=false";

export const codexAppServerCommand = (
  cwd: string,
  stdin?: ChildProcess.CommandOptions["stdin"],
): ChildProcess.Command => {
  const options: ChildProcess.CommandOptions = {
    // Starting outside the worktree prevents process startup from
    // discovering repository-owned config before thread trust is set.
    cwd: homedir(),
    // The app-server must die with the run host: staying in the host's
    // process group keeps the executor's hard kill able to reap it, and the
    // bounded SIGTERM window implements ADR 0006's grace-then-force stop.
    detached: false,
    forceKillAfter: "5 seconds",
  };
  return ChildProcess.make(
    "codex",
    [
      "app-server",
      "--stdio",
      "-c",
      repositoryTrustOverride(cwd),
      "-c",
      disableRecursiveAgentsOverride,
    ],
    stdin === undefined ? options : { ...options, stdin },
  );
};

const makeCodexAppServer = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const open: CodexAppServer["Service"]["open"] = Effect.fn("CodexAppServer.open")(
    function* (request) {
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
          codexAppServerCommand(request.cwd, {
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
              : operationError(operation, request, "Could not write to Codex app-server", cause),
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

      // One effect per stdout line, deliberately span-free: a line is not an
      // operation, and unrecognized input is logged and skipped so a stray
      // frame can never fail the session (ADR 0002 would retry it as infra).
      const routeLine = (line: string) =>
        Effect.gen(function* () {
          if (line.trim().length === 0) return;
          const decoded = yield* decodeLine(line).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Skipping a non-JSON Codex app-server line", {
                cause,
                line: preview(line),
                sessionId: request.session.id,
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
                sessionId: request.session.id,
              });
            }
            if (Schema.is(RpcErrorResponse)(decoded)) {
              return yield* Deferred.fail(
                found.value.response,
                operationError(
                  found.value.operation,
                  request,
                  `Codex app-server rejected ${decoded.error.message}`,
                  decoded.error,
                ),
              );
            }
            return yield* Deferred.succeed(found.value.response, decoded.result);
          }
          if (!Schema.is(RpcMessage)(decoded)) {
            return yield* Effect.logWarning("Skipping an unknown Codex JSON-RPC shape", {
              line: preview(line),
              sessionId: request.session.id,
            });
          }
          if (decoded.id !== undefined) {
            yield* Effect.logWarning("Codex app-server requested unsupported client input", {
              method: decoded.method,
              sessionId: request.session.id,
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

      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(routeLine),
        Effect.flatMap(() =>
          Ref.get(closing).pipe(
            Effect.flatMap((closed) =>
              closed
                ? Effect.void
                : failAll(
                    operationError(
                      "stream",
                      request,
                      "Codex app-server output closed unexpectedly",
                      new Error("unexpected end of output"),
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch((error) =>
          failAll(
            error instanceof SessionOperationError
              ? error
              : operationError("stream", request, "Could not read Codex app-server output", error),
          ),
        ),
        Effect.forkScoped,
      );
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          line.trim().length === 0
            ? Effect.void
            : Effect.logDebug("Codex app-server stderr", {
                line: preview(line),
                sessionId: request.session.id,
              }).pipe(
                Effect.andThen(
                  Ref.update(stderrTail, (tail) => [...tail, line].slice(-STDERR_TAIL_LINES)),
                ),
              ),
        ),
        Effect.catch((cause) =>
          failAll(
            operationError("stream", request, "Could not read Codex app-server diagnostics", cause),
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
          failAll(operationError("stream", request, "Could not monitor Codex app-server", cause)),
        ),
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() =>
        Effect.logDebug("Closing Codex app-server", { sessionId: request.session.id }).pipe(
          Effect.andThen(Ref.set(closing, true)),
          Effect.andThen(Queue.end(input)),
          Effect.andThen(handle.kill()),
          Effect.catch((cause) =>
            Effect.logWarning("Could not stop Codex app-server cleanly", {
              cause,
              sessionId: request.session.id,
            }),
          ),
        ),
      );

      const requestRpc: CodexConnection["request"] = (operation, method, params) =>
        Effect.gen(function* () {
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
                      `Codex app-server did not answer ${method} within ${RPC_TIMEOUT}`,
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
        notifications: Stream.fromQueue(notifications),
        request: requestRpc,
        notify,
      } satisfies CodexConnection;
    },
  );
  return CodexAppServer.of({ open });
});

export const codexAppServerLive = Layer.effect(CodexAppServer, makeCodexAppServer);
