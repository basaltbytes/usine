import { assert } from "@effect/vitest";
import { type Cause, Deferred, Effect, Predicate, Queue, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

const decodeOwnerInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      sequence: Schema.optionalKey(Schema.Int),
      data: Schema.optionalKey(Schema.String),
      checkpoint: Schema.optionalKey(Schema.Boolean),
      offset: Schema.optionalKey(Schema.Int),
      skip: Schema.optionalKey(Schema.Int),
    }),
  ),
);
const encodeOwnerFrame = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** Writes one owner relay frame to the orchestrator. */
export type OwnerFrame = (value: Schema.Json) => Effect.Effect<boolean>;

/**
 * An owner relay that writes `initial`, passes each input frame to `onInput`, and confirms
 * checkpoints. `frame` writes further frames; `saved` holds the confirmed detach checkpoint.
 */
export const scriptedOwner = (
  initial: ReadonlyArray<Schema.Json>,
  onInput: (sequence: number, frame: OwnerFrame) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const ownerOutput = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const frame: OwnerFrame = (value) =>
      encodeOwnerFrame(value).pipe(
        Effect.orDie,
        Effect.flatMap((line) => Queue.offer(ownerOutput, Buffer.from(`${line}\n`))),
      );
    const saved = yield* Deferred.make<{ readonly offset: number; readonly skip: number }>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert(command._tag === "StandardCommand");
        const stdin = command.options.stdin;
        assert(Predicate.hasProperty(stdin, "stream") && Stream.isStream(stdin.stream));
        for (const value of initial) yield* frame(value);
        yield* stdin.stream.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.drop(1),
          Stream.mapEffect((text) => decodeOwnerInput(text)),
          Stream.runForEach((input) =>
            Effect.gen(function* () {
              if (input.data !== undefined && input.sequence !== undefined)
                yield* onInput(input.sequence, frame);
              if (
                input.checkpoint === true &&
                input.offset !== undefined &&
                input.skip !== undefined
              ) {
                yield* Deferred.succeed(saved, { offset: input.offset, skip: input.skip });
                yield* frame({ offset: 40, checkpoint: true });
              }
            }),
          ),
          Effect.orDie,
          Effect.forkScoped,
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromQueue(ownerOutput),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    return { spawner, saved, frame };
  });
