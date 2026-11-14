import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { boundedLines, MAX_PROTOCOL_LINE_BYTES } from "../../src/child-host/lines.ts";
import { startChildProcess } from "../../src/child-host/node.ts";
import { scriptedCommand, scriptedTarget } from "./scripted-owner.ts";

const encoder = new TextEncoder();

describe("bounded protocol lines", () => {
  it.effect("decodes split UTF-8, CRLF, and a final line at the byte limit", () =>
    Effect.gen(function* () {
      const prefix = encoder.encode("λ\r\nnext\n");
      const lines = yield* boundedLines(
        Stream.make(
          prefix.subarray(0, 1),
          prefix.subarray(1),
          encoder.encode("x".repeat(MAX_PROTOCOL_LINE_BYTES)),
        ),
        () => "oversized",
      ).pipe(Stream.runCollect);
      assert.deepStrictEqual(lines, ["λ", "next", "x".repeat(MAX_PROTOCOL_LINE_BYTES)]);
    }),
  );

  it.effect("leaves a partial owner frame for replay after a transport disconnect", () =>
    Effect.gen(function* () {
      const lines = yield* boundedLines(
        Stream.make(encoder.encode('complete\n{"offset":')),
        () => "oversized",
        "discard",
      ).pipe(Stream.runCollect);
      assert.deepStrictEqual(lines, ["complete"]);
    }),
  );

  for (const terminated of [false, true]) {
    it.effect(
      `fails the process-owner session on an oversized ${terminated ? "complete" : "unfinished"} frame`,
      () => {
        let launches = 0;
        const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              const first = launches++ === 0;
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(4242),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: first
                  ? Stream.fromIterable([
                      ...Array.from({ length: 64 }, () => encoder.encode("x".repeat(65536))),
                      encoder.encode(terminated ? "x\n" : "x"),
                    ])
                  : Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              });
            }),
          ),
        );
        return Effect.gen(function* () {
          const owner = yield* startChildProcess(scriptedTarget, scriptedCommand, Stream.never);
          const failure = yield* owner.stdout.pipe(Stream.runDrain, Effect.flip);
          assert.include(failure.message, "frame exceeds 4 MiB");
          const exited = yield* owner.exit.pipe(Effect.flip);
          assert.strictEqual(exited, failure);
          const generation = yield* owner.generation.pipe(Effect.flip);
          assert.strictEqual(generation, failure);
        }).pipe(Effect.scoped, Effect.provide(spawner));
      },
    );
  }
});
