#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Logger, Stdio, Stream } from "effect";
import { Console } from "node:console";

// Libraries and independent Effect runtimes may use the process console instead
// of this program's Logger context. Protocol frames use Stdio directly; every
// console method must write to stderr before the agent backends are imported.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  if (args.includes("--protocol-version")) {
    yield* Effect.logTrace("reporting protocol version");
    yield* Stream.run(Stream.make(`${AttemptChannel.PROTOCOL_VERSION}\n`), stdio.stdout());
    return;
  }
  const delayFlag = args.indexOf("--stub-delay-ms");
  const candidate = delayFlag < 0 ? undefined : args[delayFlag + 1];
  const stubDelayMillis = candidate === undefined ? 0 : Number(candidate);
  if (!Number.isSafeInteger(stubDelayMillis) || stubDelayMillis < 0) {
    return yield* Effect.die(new Error("--stub-delay-ms must be a non-negative integer"));
  }
  const useStub = args.includes("--stub") || delayFlag >= 0;
  const [{ runHost }, agentLayer] = yield* Effect.promise(() =>
    Promise.all([
      import("./run-host.ts"),
      useStub
        ? import("./stub.ts").then(({ stubLayer }) => stubLayer(stubDelayMillis))
        : import("@usine/agents/pi/live").then(({ layer }) => layer),
    ]),
  );
  yield* runHost().pipe(Effect.provide(agentLayer));
}).pipe(Effect.provide(NodeServices.layer), Effect.provideService(Logger.LogToStderr, true));

NodeRuntime.runMain(program);
