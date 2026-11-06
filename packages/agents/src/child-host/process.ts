import type { AgentSessionId } from "@usine/core/agent/session";
import {
  type Brand,
  Cause,
  Deferred,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { Base64 } from "effect/encoding";
import { ChildProcessSpawner } from "effect/process";
import { childPidFile, type ChildHost, SSH_FAILURE } from "./child-host.ts";
import { hostCommand, hostOutput } from "./command.ts";
import { PROCESS_OWNER } from "./supervisor.ts";
import { ChildSessionLifecycle, SessionOperationError } from "../runtime.ts";

export class ChildProcessLost extends Schema.TaggedError<
  ChildProcessLost,
  Brand.Brand<"@usine/agents/child-host/ChildProcessLost">
>("@usine/agents/ChildProcessLost")("ChildProcessLost", {
  exitCode: Schema.Int,
  stderrTail: Schema.String,
}) {}

export interface ProcessTarget {
  readonly host: ChildHost;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly sessionId: Option.Option<AgentSessionId>;
}

export interface ProcessCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

export const processError = (target: ProcessTarget, message: string, cause: unknown) =>
  SessionOperationError.make({ operation: "stream", sessionId: target.sessionId, message, cause });

const Frame = Schema.Union([
  Schema.Struct({ offset: Schema.Int, stdout: Schema.String }),
  Schema.Struct({ offset: Schema.Int, ack: Schema.Int }),
  Schema.Struct({ offset: Schema.Int, exitCode: Schema.Int, stderrTail: Schema.String }),
  Schema.Struct({
    offset: Schema.Int,
    ready: Schema.Literal(true),
    sequence: Schema.Int,
    retained: Schema.Boolean,
  }),
]);
const InputFrame = Schema.Union([
  Schema.Struct({ sequence: Schema.Int, data: Schema.String }),
  Schema.Struct({ sequence: Schema.Int, eof: Schema.Literal(true) }),
]);
const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(Frame));
const encoder = new TextEncoder();
const PROCESS_LEASE_MS = 120_000;

/** Stops a retained child and removes its journals after confirming termination. */
export const stopChildProcess = Effect.fn("ChildHost.stopChildProcess")(function* (
  target: ProcessTarget,
) {
  if (Option.isNone(target.sessionId)) return;
  yield* Effect.annotateCurrentSpan({ sessionId: target.sessionId.value });
  const pidFile = childPidFile(target.cwd, target.sessionId.value);
  for (const mode of ["stop", "remove"]) {
    const result = yield* hostOutput(target.host, {
      command: "node",
      args: ["-e", PROCESS_OWNER, mode, pidFile, "0", String(PROCESS_LEASE_MS)],
      environment: target.environment,
    }).pipe(
      Effect.mapError((cause) => processError(target, "Could not stop the child process", cause)),
    );
    if (result.exitCode !== 0)
      return yield* processError(target, "Could not confirm the child process stopped", {
        exitCode: result.exitCode,
      });
  }
  yield* Effect.logInfo("Stopped the child process and removed its journals", {
    sessionId: target.sessionId.value,
  });
});

/** Keeps the worker process alive across SSH loss; input is replayed until acknowledged. */
export const remoteProcess = Effect.fn("ChildHost.remoteProcess")(function* (
  target: ProcessTarget & { readonly sessionId: Option.Some<AgentSessionId> },
  command: ProcessCommand,
  input: Stream.Stream<Uint8Array>,
  transport?: "replace" | "resume",
) {
  const lifecycle = yield* ChildSessionLifecycle.current;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdout = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
  const exit = yield* Deferred.make<ChildProcessLost, SessionOperationError>();
  const outgoing = yield* Queue.make<string, Cause.Done>();
  const history = new Map<number, string>();
  let sequence = 0;
  const ready = yield* Deferred.make<void, SessionOperationError>();
  const generation = yield* Deferred.make<Option.Option<number>, SessionOperationError>();
  const offset = yield* Ref.make(0);
  const pidFile = childPidFile(target.cwd, target.sessionId.value);
  const fields = { sessionId: target.sessionId.value };
  const environmentKeys = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.String)),
  )(Object.keys(target.environment).sort()).pipe(Effect.orDie);
  yield* Effect.annotateCurrentSpan(fields);
  if (transport === "replace") yield* stopChildProcess(target);

  const send = (frame: { readonly data: string } | { readonly eof: true }) =>
    Effect.gen(function* () {
      if (yield* lifecycle.isStopping) return;
      yield* Deferred.await(ready);
      sequence += 1;
      const line = yield* Schema.encodeEffect(Schema.fromJsonString(InputFrame))({
        ...frame,
        sequence,
      }).pipe(Effect.orDie);
      history.set(sequence, line);
      yield* Queue.offer(outgoing, line);
    });
  yield* input.pipe(
    Stream.runForEach((data) => send({ data: Base64.encode(data) })),
    Effect.andThen(
      Effect.gen(function* () {
        if (yield* lifecycle.isStopping) {
          const cursor = yield* Ref.get(offset);
          yield* Queue.offer(outgoing, `{"heartbeat":true,"offset":${cursor}}`);
        } else yield* send({ eof: true });
      }),
    ),
    Effect.andThen(Queue.end(outgoing)),
    Effect.forkScoped,
  );

  let failures = 0;
  const relay = Effect.fn("ChildHost.relay")(function* () {
    yield* Effect.annotateCurrentSpan(fields);
    const cursor = yield* Ref.get(offset);
    const replay = [...history.values()];
    const replayed = new Set(replay);
    const frames = Stream.concat(
      Stream.fromIterable(replay),
      Stream.fromQueue(outgoing).pipe(Stream.filter((line) => !replayed.has(line))),
    );
    const handle = yield* spawner.spawn(
      hostCommand(
        target.host,
        {
          ...command,
          command: "node",
          args: [
            "-e",
            PROCESS_OWNER,
            transport === "resume" && cursor === 0 ? "resume" : "attach",
            pidFile,
            String(cursor),
            String(PROCESS_LEASE_MS),
            environmentKeys,
            command.command,
            ...command.args,
          ],
          environment: target.environment,
        },
        {
          detached: false,
          forceKillAfter: "5 seconds",
          stdin: {
            stream: Stream.merge(
              frames,
              Stream.tick("1 second").pipe(
                Stream.mapEffect(() => Ref.get(offset)),
                Stream.map((cursor) => `{"heartbeat":true,"offset":${cursor}}`),
              ),
              { haltStrategy: "left" },
            ).pipe(Stream.map((line) => encoder.encode(`${line}\n`))),
            endOnDone: false,
          },
        },
      ),
    );
    const read = handle.stdout.pipe(
      Stream.decodeText(),
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
            if (!(yield* Deferred.isDone(ready))) {
              sequence = frame.sequence;
              yield* Deferred.succeed(
                generation,
                frame.retained === true ? Option.some(sequence) : Option.none(),
              );
              yield* Deferred.succeed(ready, undefined);
            }
            yield* Effect.logInfo("Connected to the child process owner", {
              ...fields,
              offset: cursor,
              retained: frame.retained,
            });
          } else if ("ack" in frame) {
            for (const id of history.keys()) if (id <= frame.ack) history.delete(id);
          } else if ("stdout" in frame) {
            const bytes = yield* Effect.fromResult(Base64.decode(frame.stdout));
            yield* Queue.offer(stdout, bytes);
          } else {
            yield* Deferred.succeed(
              exit,
              ChildProcessLost.make({ exitCode: frame.exitCode, stderrTail: frame.stderrTail }),
            );
          }
          yield* Ref.set(offset, frame.offset);
        }),
      ),
    );
    let stderrTail = "";
    const diagnostics = handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        Effect.sync(() => {
          stderrTail = (stderrTail + text).slice(-8192);
        }),
      ),
    );
    const [, , code] = yield* Effect.all([read, diagnostics, handle.exitCode], {
      concurrency: "unbounded",
    });
    return { code, stderrTail };
  });
  const monitor = yield* Effect.gen(function* () {
    while (!(yield* Deferred.isDone(exit))) {
      if (yield* lifecycle.isStopping) return yield* Effect.never;
      const { code, stderrTail } = yield* Effect.scoped(relay());
      if (yield* lifecycle.isStopping) return yield* Effect.never;
      if (yield* Deferred.isDone(exit)) break;
      if (code !== SSH_FAILURE)
        return yield* processError(
          target,
          "The child process owner relay stopped without an exit event",
          { relayExitCode: code, stderrTail },
        );
      failures += 1;
      const delaySeconds = Math.min(30, 2 ** Math.min(failures - 1, 5));
      yield* Effect.logWarning("SSH connection dropped; reattaching the child process owner", {
        ...fields,
        failures,
        delaySeconds,
        offset: yield* Ref.get(offset),
      });
      yield* Effect.sleep(`${delaySeconds} seconds`);
    }
    yield* Queue.end(stdout);
    const result = yield* Deferred.await(exit);
    yield* Effect.logInfo("Child process exited", { ...fields, exitCode: result.exitCode });
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(SessionOperationError)(cause)
        ? cause
        : processError(target, "Could not communicate with the child process owner", cause),
    ),
    Effect.tapError((error) =>
      Effect.logWarning("Child process transport failed", {
        ...fields,
        message: error.message,
      }).pipe(
        Effect.andThen(
          Effect.all([
            Deferred.fail(exit, error),
            Deferred.fail(ready, error),
            Deferred.fail(generation, error),
            Queue.fail(stdout, error),
          ]),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  const kill = () =>
    stopChildProcess(target).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.andThen(Fiber.interrupt(monitor)),
    );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (yield* lifecycle.isStopping) return;
      yield* kill().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Could not stop the child process owner", { ...fields, cause }),
        ),
        Effect.ignore,
      );
    }),
  );
  return {
    stdout: Stream.fromQueue(stdout),
    exit: Deferred.await(exit),
    generation: Deferred.await(generation),
    kill,
  };
});
