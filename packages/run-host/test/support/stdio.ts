import { AgentRuntime } from "@usine/agents/runtime";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Cause, Effect, Fiber, Queue, Schema, Sink, Stdio, Stream } from "effect";
import { runHost } from "../../src/run-host.ts";

const encodeInput = Schema.encodeSync(AttemptChannel.InputFrameFromJson);

/** Runs the production host against byte streams; stdout is decoded independently of its writes. */
export const startHost = Effect.fn("test.startHost")(function* (runtime: AgentRuntime["Service"]) {
  const stdin = yield* Queue.make<Uint8Array, Cause.Done>();
  const stdout = yield* Queue.make<Uint8Array, Cause.Done>();
  const received = yield* Queue.make<AttemptChannel.OutboundEnvelope>();
  const frames: Array<AttemptChannel.OutboundEnvelope> = [];
  const output = yield* Stream.fromQueue(stdout).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapEffect((line) =>
      Schema.decodeUnknownEffect(AttemptChannel.OutboundEnvelopeFromJson)(line, {
        onExcessProperty: "error",
      }),
    ),
    Stream.runForEach((frame) => {
      frames.push(frame);
      return Queue.offer(received, frame);
    }),
    Effect.orDie,
    Effect.forkScoped,
  );
  const io = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(stdin),
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Queue.offer(stdout, chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk)),
      ),
    stderr: () => Sink.drain,
  });
  const host = yield* runHost().pipe(
    Effect.provideService(AgentRuntime, runtime),
    Effect.provideService(Stdio.Stdio, io),
    Effect.ensuring(Queue.end(stdout)),
    Effect.forkScoped,
  );
  return {
    stdin,
    frames,
    send: (frame: AttemptChannel.InputFrame) =>
      Queue.offer(stdin, new TextEncoder().encode(`${encodeInput(frame)}\n`)),
    next: Queue.take(received),
    result: Fiber.join(host).pipe(Effect.ensuring(Fiber.join(output))),
  };
});
