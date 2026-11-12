import type { AgentSessionId } from "@usine/core/agent/session";
import {
  type Brand,
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { Base64 } from "effect/encoding";
import { ChildProcessSpawner } from "effect/process";
import { childPidFile, type ChildHost, SSH_FAILURE } from "./child-host.ts";
import { hostOutput, hostSpawn } from "./command.ts";
import { unreachableCause } from "./exec.ts";
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

/** How a process owner launches a child and checkpoints its output. */
export interface ProcessOptions {
  /** `replace` stops the child's retained process first; `resume` can adopt it. */
  readonly transport?: "replace" | "resume" | undefined;
  /** `received`, the default, checkpoints output on arrival; `handled` waits for `acknowledgeOutput`. */
  readonly acknowledgement?: "received" | "handled";
  /** Runs for each input chunk the child acknowledges; returns the output bytes that became checkpointed. */
  readonly onInputAcknowledged?: (bytes: Uint8Array) => Effect.Effect<number>;
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
const DETACH_CHECKPOINT_TIMEOUT = Duration.seconds(5);
// Leaves one second of the detach budget for the checkpoint round trip.
const INPUT_DRAIN_TIMEOUT = Duration.subtract(DETACH_CHECKPOINT_TIMEOUT, Duration.seconds(1));

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
      environment: {},
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
  {
    transport,
    acknowledgement = "received",
    onInputAcknowledged = () => Effect.succeed(0),
  }: ProcessOptions = {},
) {
  const lifecycle = yield* ChildSessionLifecycle.current;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdout = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
  const exit = yield* Deferred.make<ChildProcessLost, SessionOperationError>();
  const outgoing = yield* Queue.make<string, Cause.Done>();
  // Input frames the owner has not acknowledged, by sequence.
  const history = yield* SubscriptionRef.make<
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
  const environment = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  )(target.environment).pipe(Effect.orDie);
  yield* Effect.annotateCurrentSpan(fields);
  if (transport === "replace") yield* stopChildProcess(target);

  /** Sends `data`, or end of file when it is `None`. */
  const send = (data: Option.Option<Uint8Array>) =>
    Effect.gen(function* () {
      if (yield* lifecycle.isStopping) return;
      yield* Deferred.await(ready);
      const id = yield* Ref.updateAndGet(sequence, (value) => value + 1);
      const line = yield* Schema.encodeEffect(Schema.fromJsonString(InputFrame))(
        Option.match(data, {
          onNone: () => ({ sequence: id, eof: true as const }),
          onSome: (data) => ({ sequence: id, data: Base64.encode(data) }),
        }),
      ).pipe(Effect.orDie);
      yield* SubscriptionRef.update(history, (entries) =>
        new Map(entries).set(id, { line, data: Option.getOrElse(data, () => new Uint8Array()) }),
      );
      yield* Queue.offer(outgoing, line);
    });
  yield* input.pipe(
    Stream.runForEach((data) => send(Option.some(data))),
    Effect.andThen(
      Effect.gen(function* () {
        if (yield* lifecycle.isStopping) return;
        yield* send(Option.none());
        yield* Queue.end(outgoing);
      }),
    ),
    Effect.forkScoped,
  );

  const failures = yield* Ref.make(0);
  const launched = yield* Ref.make(false);
  const replay = Effect.fn("ChildHost.replay")(function* () {
    yield* Effect.annotateCurrentSpan(fields);
    const lines = [...(yield* SubscriptionRef.get(history)).values()].map(({ line }) => line);
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
    const handle = yield* hostSpawn(
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
          command.command,
          ...command.args,
        ],
        environment: {},
      },
      {
        detached: false,
        forceKillAfter: "5 seconds",
        stdin: {
          stream: Stream.concat(
            Stream.succeed(environment),
            Stream.merge(
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
            ),
          ).pipe(Stream.map((line) => encoder.encode(`${line}\n`))),
          endOnDone: false,
        },
      },
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
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
            const acknowledged = [...(yield* SubscriptionRef.get(history))].filter(
              ([id]) => id <= frame.ack,
            );
            for (const [, entry] of acknowledged) {
              const bytes = yield* onInputAcknowledged(entry.data);
              yield* acknowledgeOutput(bytes);
            }
            if (acknowledged.length > 0)
              yield* SubscriptionRef.update(
                history,
                (entries) => new Map([...entries].filter(([id]) => id > frame.ack)),
              );
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
    // The output keeps the bytes received before an exec shell's transport failed, so it's read
    // to its end before the exit code.
    yield* Effect.all([read, diagnostics], { concurrency: "unbounded" });
    const tail = yield* Ref.get(stderr);
    // A relay that ended with an exit code, or why the transport lost it.
    const relay = yield* handle.exitCode.pipe(
      Effect.map((code) =>
        target.host._tag === "RemoteShell" && code === SSH_FAILURE
          ? Result.fail(tail.trim().split("\n").at(-1) ?? "")
          : Result.succeed(code),
      ),
      Effect.catchTag("PlatformError", (error) =>
        Option.match(unreachableCause(error), {
          onNone: () => Effect.fail(error),
          onSome: (unreachable) => Effect.succeed(Result.fail(unreachable.message)),
        }),
      ),
    );
    return { relay, stderrTail: tail };
  });
  const reattach = Effect.fn("ChildHost.reattach")(function* (
    relay: Result.Result<number, string>,
    stderrTail: string,
  ) {
    yield* Effect.annotateCurrentSpan(fields);
    if (Result.isSuccess(relay))
      return yield* processError(
        target,
        "The child process owner relay stopped without an exit event",
        { relayExitCode: relay.success, stderrTail },
      );
    const attempts = yield* Ref.updateAndGet(failures, (value) => value + 1);
    const delaySeconds = Math.min(30, 2 ** Math.min(attempts - 1, 5));
    yield* Effect.logWarning("Connection to the child process owner dropped; reattaching it", {
      ...fields,
      host: target.host._tag,
      reason: relay.failure,
      failures: attempts,
      delaySeconds,
      offset: yield* Ref.get(offset),
    });
    yield* Effect.sleep(`${delaySeconds} seconds`);
  });
  const monitor = yield* Effect.gen(function* () {
    while (!(yield* Deferred.isDone(exit))) {
      if (yield* lifecycle.isStopping) return yield* Effect.never;
      const { relay, stderrTail } = yield* Effect.scoped(connect().pipe(Effect.flatMap(stream)));
      if (yield* lifecycle.isStopping) return yield* Effect.never;
      if (yield* Deferred.isDone(exit)) break;
      yield* reattach(relay, stderrTail);
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
          const unacknowledged = (yield* SubscriptionRef.get(history)).size;
          if (unacknowledged > 0) {
            yield* Effect.logDebug(
              "Waiting for the owner to acknowledge input before the output checkpoint",
              { ...fields, unacknowledged },
            );
            const drained = yield* SubscriptionRef.changes(history).pipe(
              Stream.filter((entries) => entries.size === 0),
              Stream.take(1),
              Stream.runDrain,
              Effect.timeoutOption(INPUT_DRAIN_TIMEOUT),
            );
            if (Option.isNone(drained))
              yield* Effect.logWarning(
                "The owner did not acknowledge input before detaching; saving the output checkpoint without it",
                { ...fields, unacknowledged: (yield* SubscriptionRef.get(history)).size },
              );
          }
          const cursor = yield* output.cursor;
          yield* Queue.offer(
            outgoing,
            `{"heartbeat":true,"checkpoint":true,"offset":${cursor.offset},"skip":${cursor.skip}}`,
          );
          yield* Deferred.await(checkpoint);
        }).pipe(
          Effect.timeout(DETACH_CHECKPOINT_TIMEOUT),
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
