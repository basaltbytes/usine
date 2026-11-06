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
import { outputAcknowledgements } from "./output.ts";
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
  Schema.Struct({ offset: Schema.Int, checkpoint: Schema.Literal(true) }),
  Schema.Struct({ offset: Schema.Int, exitCode: Schema.Int, stderrTail: Schema.String }),
  Schema.Struct({
    offset: Schema.Int,
    ready: Schema.Literal(true),
    sequence: Schema.Int,
    retained: Schema.Boolean,
    skip: Schema.optionalKey(Schema.Int),
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
  acknowledgement: "received" | "handled" = "received",
  onInputAcknowledged: (bytes: Uint8Array) => Effect.Effect<number> = () => Effect.succeed(0),
) {
  const lifecycle = yield* ChildSessionLifecycle.current;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdout = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
  const exit = yield* Deferred.make<ChildProcessLost, SessionOperationError>();
  const outgoing = yield* Queue.make<string, Cause.Done>();
  const history = yield* Ref.make<
    ReadonlyMap<number, { readonly line: string; readonly data: Uint8Array }>
  >(new Map());
  const sequence = yield* Ref.make(0);
  const ready = yield* Deferred.make<void, SessionOperationError>();
  const checkpoint = yield* Deferred.make<void>();
  const generation = yield* Deferred.make<Option.Option<number>, SessionOperationError>();
  const offset = yield* Ref.make(0);
  const output = yield* outputAcknowledgements();
  const acknowledgeOutput = output.acknowledge;
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
      const id = yield* Ref.updateAndGet(sequence, (value) => value + 1);
      const line = yield* Schema.encodeEffect(Schema.fromJsonString(InputFrame))({
        ...frame,
        sequence: id,
      }).pipe(Effect.orDie);
      const data =
        "data" in frame ? yield* Effect.fromResult(Base64.decode(frame.data)) : new Uint8Array();
      yield* Ref.update(history, (entries) => new Map(entries).set(id, { line, data }));
      yield* Queue.offer(outgoing, line);
    });
  yield* input.pipe(
    Stream.runForEach((data) => send({ data: Base64.encode(data) })),
    Effect.andThen(
      Effect.gen(function* () {
        if (yield* lifecycle.isStopping) return;
        yield* send({ eof: true });
        yield* Queue.end(outgoing);
      }),
    ),
    Effect.forkScoped,
  );

  const failures = yield* Ref.make(0);
  const launched = yield* Ref.make(false);
  const replay = Effect.fn("ChildHost.replay")(function* () {
    yield* Effect.annotateCurrentSpan(fields);
    const lines = [...(yield* Ref.get(history)).values()].map(({ line }) => line);
    const replayed = new Set(lines);
    return Stream.concat(
      Stream.fromIterable(lines),
      Stream.fromQueue(outgoing).pipe(Stream.filter((line) => !replayed.has(line))),
    );
  });
  const connect = Effect.fn("ChildHost.connect")(function* () {
    yield* Effect.annotateCurrentSpan(fields);
    const cursor = yield* Ref.get(offset);
    const wasLaunched = yield* Ref.getAndSet(launched, true);
    const mode = (yield* Deferred.isDone(ready))
      ? "attach"
      : transport === "resume"
        ? "resume"
        : wasLaunched
          ? "attach"
          : "replace";
    const relayReady = yield* Deferred.make<void>();
    const frames = yield* replay();
    const handle = yield* spawner.spawn(
      hostCommand(
        target.host,
        {
          ...command,
          command: "node",
          args: [
            "-e",
            PROCESS_OWNER,
            mode,
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
                Stream.mapEffect(() =>
                  Deferred.await(relayReady).pipe(Effect.andThen(output.cursor)),
                ),
                Stream.map(
                  (cursor) => `{"heartbeat":true,"offset":${cursor.offset},"skip":${cursor.skip}}`,
                ),
              ),
              { haltStrategy: "left" },
            ).pipe(Stream.map((line) => encoder.encode(`${line}\n`))),
            endOnDone: false,
          },
        },
      ),
    );
    return { handle, relayReady, cursor };
  });
  const stream = Effect.fn("ChildHost.stream")(function* ({
    handle,
    relayReady,
    cursor,
  }: {
    readonly handle: ChildProcessSpawner.ChildProcessHandle;
    readonly relayReady: Deferred.Deferred<void>;
    readonly cursor: number;
  }) {
    yield* Effect.annotateCurrentSpan(fields);
    const skipped = yield* Ref.make(0);
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
          if ("checkpoint" in frame) {
            yield* Deferred.succeed(checkpoint, undefined);
            return;
          }
          if ("ready" in frame) {
            if (!(yield* Deferred.isDone(ready))) {
              yield* output.reset({ offset: frame.offset, skip: frame.skip ?? 0 });
            }
            yield* Ref.set(skipped, frame.skip ?? 0);
            yield* Deferred.succeed(relayReady, undefined);
            yield* Ref.set(failures, 0);
            if (!(yield* Deferred.isDone(ready))) {
              yield* Ref.set(sequence, frame.sequence);
              yield* Deferred.succeed(
                generation,
                frame.retained === true ? Option.some(frame.sequence) : Option.none(),
              );
              yield* Deferred.succeed(ready, undefined);
            }
            yield* Effect.logInfo("Connected to the child process owner", {
              ...fields,
              offset: cursor,
              retained: frame.retained,
            });
          } else if ("ack" in frame) {
            if (acknowledgement === "handled")
              yield* output.record({
                remaining: 0,
                handled: 0,
                start: yield* Ref.get(offset),
                offset: frame.offset,
              });
            for (const [id, entry] of yield* Ref.get(history))
              if (id <= frame.ack) {
                yield* Ref.update(history, (entries) => {
                  const remaining = new Map(entries);
                  remaining.delete(id);
                  return remaining;
                });
                const bytes = yield* onInputAcknowledged(entry.data);
                yield* acknowledgeOutput(bytes);
              }
          } else if ("stdout" in frame) {
            const bytes = yield* Effect.fromResult(Base64.decode(frame.stdout));
            if (acknowledgement === "handled")
              yield* output.record({
                remaining: bytes.length,
                handled: yield* Ref.get(skipped),
                start: yield* Ref.get(offset),
                offset: frame.offset,
              });
            yield* Ref.set(skipped, 0);
            yield* Queue.offer(stdout, bytes);
          } else {
            if (acknowledgement === "handled")
              yield* output.record({
                remaining: 0,
                handled: 0,
                start: yield* Ref.get(offset),
                offset: frame.offset,
              });
            yield* Deferred.succeed(
              exit,
              ChildProcessLost.make({ exitCode: frame.exitCode, stderrTail: frame.stderrTail }),
            );
          }
          yield* Ref.set(offset, frame.offset);
          if (acknowledgement === "received")
            yield* output.reset({ offset: frame.offset, skip: 0 });
          else yield* acknowledgeOutput(0);
        }),
      ),
    );
    const stderr = yield* Ref.make("");
    const diagnostics = handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(stderr, (tail) => (tail + text).slice(-8192))),
    );
    const [, , code] = yield* Effect.all([read, diagnostics, handle.exitCode], {
      concurrency: "unbounded",
    });
    return { code, stderrTail: yield* Ref.get(stderr) };
  });
  const reattach = Effect.fn("ChildHost.reattach")(function* (
    code: ChildProcessSpawner.ExitCode,
    stderrTail: string,
  ) {
    yield* Effect.annotateCurrentSpan(fields);
    if (code !== SSH_FAILURE)
      return yield* processError(
        target,
        "The child process owner relay stopped without an exit event",
        { relayExitCode: code, stderrTail },
      );
    const attempts = yield* Ref.updateAndGet(failures, (value) => value + 1);
    const delaySeconds = Math.min(30, 2 ** Math.min(attempts - 1, 5));
    yield* Effect.logWarning("SSH connection dropped; reattaching the child process owner", {
      ...fields,
      failures: attempts,
      delaySeconds,
      offset: yield* Ref.get(offset),
    });
    yield* Effect.sleep(`${delaySeconds} seconds`);
  });
  const monitor = yield* Effect.gen(function* () {
    while (!(yield* Deferred.isDone(exit))) {
      if (yield* lifecycle.isStopping) return yield* Effect.never;
      const { code, stderrTail } = yield* Effect.scoped(connect().pipe(Effect.flatMap(stream)));
      if (yield* lifecycle.isStopping) return yield* Effect.never;
      if (yield* Deferred.isDone(exit)) break;
      yield* reattach(code, stderrTail);
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
      if (yield* lifecycle.isStopping) {
        if (!(yield* Deferred.isDone(ready))) {
          yield* Effect.logInfo(
            "Detached before the owner was ready; preserving its output checkpoint",
            fields,
          );
          return;
        }
        yield* Effect.gen(function* () {
          yield* Deferred.await(ready);
          const cursor = yield* output.cursor;
          yield* Queue.offer(
            outgoing,
            `{"heartbeat":true,"checkpoint":true,"offset":${cursor.offset},"skip":${cursor.skip}}`,
          );
          yield* Deferred.await(checkpoint);
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.tapError((cause) =>
            Effect.logWarning("Could not save the child output checkpoint before detaching", {
              ...fields,
              cause,
            }),
          ),
          Effect.ignore,
        );
        return;
      }
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
    acknowledgeOutput,
    kill,
  };
});
