import type { AgentSessionId } from "@usine/core/agent/session";
import { Cause, Deferred, Effect, Fiber, Queue, Ref, Schema, Stream } from "effect";
import { Base64 } from "effect/encoding";
import { ChildProcessSpawner } from "effect/process";
import { childPidFile, type RemoteShell, SSH_FAILURE } from "../../child-host/child-host.ts";
import { hostCommand, hostOutput } from "../../child-host/command.ts";
import { type CodexClient, operationError } from "./connection.ts";
import { CODEX_SUPERVISOR } from "./supervisor.ts";
import { SessionOperationError } from "../../runtime.ts";

export class RemoteCodexProcessLost extends Schema.TaggedError<RemoteCodexProcessLost>(
  "@usine/agents/RemoteCodexProcessLost",
)("RemoteCodexProcessLost", {
  message: Schema.String,
}) {}

const Frame = Schema.Union([
  Schema.Struct({ offset: Schema.Int, stdout: Schema.String }),
  Schema.Struct({ offset: Schema.Int, stderr: Schema.String }),
  Schema.Struct({ offset: Schema.Int, exitCode: Schema.Int }),
  Schema.Struct({ offset: Schema.Int, ready: Schema.Literal(true) }),
]);
const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(Frame));
const encoder = new TextEncoder();

/** Keeps the remote process alive while replacing failed SSH relays and replaying unacknowledged input. */
export const remoteCodexProcess = Effect.fn("CodexAppServer.remoteProcess")(function* (
  client: CodexClient & { readonly host: RemoteShell },
  sessionId: AgentSessionId,
  args: ReadonlyArray<string>,
  input: Stream.Stream<Uint8Array>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdout = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
  const stderr = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
  const exit = yield* Deferred.make<number, SessionOperationError>();
  const outgoing = yield* Queue.make<string, Cause.Done>();
  const history: Array<string> = [];
  const offset = yield* Ref.make(0);
  const pidFile = childPidFile(client.cwd, sessionId);
  const fields = { sessionId, host: client.host.destination };
  yield* Effect.annotateCurrentSpan(fields);

  const send = (frame: { readonly data: string } | { readonly eof: true }) =>
    Effect.gen(function* () {
      const line = JSON.stringify({ ...frame, sequence: history.length + 1 });
      history.push(line);
      yield* Queue.offer(outgoing, line);
    });
  yield* input.pipe(
    Stream.runForEach((data) => send({ data: Base64.encode(data) })),
    Effect.andThen(send({ eof: true })),
    Effect.andThen(Queue.end(outgoing)),
    Effect.forkScoped,
  );

  let failures = 0;
  const relay = Effect.fn("CodexAppServer.relay")(function* () {
    yield* Effect.annotateCurrentSpan(fields);
    const cursor = yield* Ref.get(offset);
    const replay = [...history];
    const handle = yield* spawner.spawn(
      hostCommand(
        client.host,
        {
          command: "node",
          args: ["-e", CODEX_SUPERVISOR, "attach", pidFile, String(cursor), ...args],
          environment: client.environment,
        },
        {
          detached: false,
          forceKillAfter: "5 seconds",
          stdin: {
            stream: Stream.concat(Stream.fromIterable(replay), Stream.fromQueue(outgoing)).pipe(
              Stream.map((line) => encoder.encode(`${line}\n`)),
            ),
            endOnDone: false,
          },
        },
      ),
    );
    const read = handle.stdout.pipe(
      Stream.decodeText(),
      // An SSH drop can truncate the last frame. Replay it from the last completed offset.
      Stream.mapAccum(
        () => "",
        (buffer, chunk) => {
          const lines = (buffer + chunk).split("\n");
          return [lines.pop() ?? "", lines];
        },
      ),
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          if (line.length === 0) return;
          const frame = yield* decodeFrame(line);
          if ("ready" in frame) {
            failures = 0;
            yield* Effect.logInfo("Connected to the remote Codex supervisor", {
              ...fields,
              offset: cursor,
            });
          }
          if ("stdout" in frame)
            yield* Queue.offer(stdout, yield* Effect.fromResult(Base64.decode(frame.stdout)));
          if ("stderr" in frame)
            yield* Queue.offer(stderr, yield* Effect.fromResult(Base64.decode(frame.stderr)));
          if ("exitCode" in frame) {
            if (frame.exitCode === 0) {
              yield* stopRemote;
              yield* Deferred.succeed(exit, frame.exitCode);
            } else
              return yield* operationError(
                "stream",
                client,
                "The remote Codex app-server exited",
                RemoteCodexProcessLost.make({ message: `exit code ${frame.exitCode}` }),
              );
          }
          yield* Ref.set(offset, frame.offset);
        }),
      ),
    );
    const [, , code] = yield* Effect.all([read, Stream.runDrain(handle.stderr), handle.exitCode], {
      concurrency: "unbounded",
    });
    return code;
  });
  const stopRemote = hostOutput(client.host, {
    command: "node",
    args: ["-e", CODEX_SUPERVISOR, "stop", pidFile, "0"],
    environment: client.environment,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : operationError(
            "interrupt",
            client,
            "Could not confirm the remote Codex process group stopped",
            { exitCode: result.exitCode },
          ),
    ),
    Effect.tap(() => Effect.logInfo("Confirmed the remote Codex process group stopped", fields)),
    Effect.mapError((cause) =>
      cause instanceof SessionOperationError
        ? cause
        : operationError(
            "interrupt",
            client,
            "Could not stop the remote Codex process group",
            cause,
          ),
    ),
  );
  const monitor = yield* Effect.gen(function* () {
    while (!(yield* Deferred.isDone(exit))) {
      const code = yield* Effect.scoped(relay());
      if (yield* Deferred.isDone(exit)) break;
      if (code !== SSH_FAILURE)
        return yield* operationError(
          "stream",
          client,
          "The remote Codex supervisor stopped before returning a result",
          RemoteCodexProcessLost.make({ message: `relay exit code ${code}` }),
        );
      failures += 1;
      const delaySeconds = Math.min(30, 2 ** Math.min(failures - 1, 5));
      yield* Effect.logWarning("Codex SSH connection dropped; reattaching the running app-server", {
        ...fields,
        failures,
        delaySeconds,
        offset: yield* Ref.get(offset),
      });
      yield* Effect.sleep(`${delaySeconds} seconds`);
    }
    yield* Queue.end(stdout);
    yield* Queue.end(stderr);
    yield* Effect.logInfo("Remote Codex app-server exited", fields);
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof SessionOperationError
        ? cause
        : operationError("stream", client, "Could not reattach the remote Codex app-server", cause),
    ),
    Effect.catchTag("SessionOperationError", (error) =>
      error.cause instanceof RemoteCodexProcessLost
        ? stopRemote.pipe(Effect.andThen(error))
        : error,
    ),
    Effect.tapError((error) =>
      Effect.logWarning("Remote Codex transport failed", {
        ...fields,
        message: error.message,
      }).pipe(
        Effect.andThen(
          Effect.all([
            Deferred.fail(exit, error),
            Queue.fail(stdout, error),
            Queue.fail(stderr, error),
          ]),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    hostOutput(client.host, {
      command: "node",
      args: ["-e", CODEX_SUPERVISOR, "remove", pidFile, "0"],
      environment: client.environment,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.timeout("5 seconds"),
      Effect.tap((result) =>
        Effect.logDebug(
          result.exitCode === 0
            ? "Removed remote Codex transport journals"
            : "Kept remote Codex transport journals while its supervisor is live",
          fields,
        ),
      ),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not remove remote Codex transport journals", { ...fields, cause }),
      ),
      Effect.ignore,
    ),
  );
  const kill = () => stopRemote.pipe(Effect.andThen(Fiber.interrupt(monitor)));

  return {
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.fromQueue(stderr),
    exitCode: Deferred.await(exit),
    kill,
  };
});
