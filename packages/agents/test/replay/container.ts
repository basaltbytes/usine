import { assert } from "@effect/vitest";
import { type Cause, Deferred, Effect, Queue, Schema, Stream } from "effect";
import type { ExecTransport } from "../../src/child-host/child-host.ts";
import { encodeWire } from "./process.ts";
import type { Tape } from "./transcript.ts";

const inputFrame = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.optionalKey(Schema.String),
      sequence: Schema.optionalKey(Schema.Int),
      eof: Schema.optionalKey(Schema.Boolean),
      checkpoint: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
const json = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));
const encoder = new TextEncoder();
const encodeFrame = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  ),
);

/** Replays native app-server traffic inside the container transport's process-owner framing. */
export const recordedContainerTransport = (tape: Tape): ExecTransport => ({
  run: (line, stdin) =>
    Effect.gen(function* () {
      assert.include(line, "'supervisor-contract' 'sh' '-c'");
      if (line.includes("'stop'") || line.includes("'remove'"))
        return { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) };
      assert(
        tape.source !== "record",
        "Record supervisor traffic through a real container runtime",
      );
      const port = tape.port("process");
      const launch = tape.source.entries.find(
        (entry) => entry.type === "expect_outbound" && entry.port === port,
      );
      assert(launch?.type === "expect_outbound");
      // The native traffic is unchanged; process launch arguments have their own runtime tests.
      tape.outbound(port, launch.payload);
      const frames = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exited = yield* Deferred.make<number>();
      let offset = 0;
      const emit = (frame: Readonly<Record<string, number | string | boolean>>) =>
        encodeFrame(frame).pipe(
          Effect.orDie,
          Effect.flatMap((wire) => Queue.offer(frames, encoder.encode(`${wire}\n`))),
        );
      yield* emit({ offset, ready: true, sequence: 0, retained: false });
      yield* stdin.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((text) =>
          Effect.gen(function* () {
            const frame = yield* inputFrame(text).pipe(Effect.orDie);
            if (frame.data !== undefined) {
              for (const message of Buffer.from(frame.data, "base64")
                .toString("utf8")
                .split("\n")
                .filter(Boolean)) {
                const payload = yield* json(message).pipe(Effect.orDie);
                tape.outbound(`${port}/stdin`, payload);
              }
            }
            if (frame.eof === true) tape.outbound(`${port}/stdin`, { eof: true });
            if (frame.sequence !== undefined) yield* emit({ offset, ack: frame.sequence });
            if (frame.checkpoint === true) yield* emit({ offset, checkpoint: true });
          }),
        ),
        Effect.forkScoped,
      );
      yield* Stream.fromEffectRepeat(Effect.promise(() => tape.read(`${port}/stdout`))).pipe(
        Stream.takeWhile((entry) => entry.type !== "runtime_exit"),
        Stream.runForEach((entry) =>
          Effect.gen(function* () {
            assert(entry.type === "emit_inbound");
            const wire = `${yield* encodeWire(entry.payload).pipe(Effect.orDie)}\n`;
            offset += Buffer.byteLength(wire);
            yield* emit({ offset, stdout: Buffer.from(wire).toString("base64") });
          }),
        ),
        Effect.andThen(Effect.promise(() => tape.read(`${port}/exit`))),
        Effect.flatMap((entry) =>
          Effect.gen(function* () {
            assert(entry.type === "runtime_exit" && entry.code !== null);
            yield* emit({ offset, exitCode: entry.code, stderrTail: "" });
            yield* Queue.end(frames);
            yield* Deferred.succeed(exited, entry.code);
          }),
        ),
        Effect.forkScoped,
      );
      return {
        stdout: Stream.fromQueue(frames),
        stderr: Stream.empty,
        exitCode: Deferred.await(exited),
      };
    }),
});
