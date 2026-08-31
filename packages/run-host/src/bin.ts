#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { layer as agentLayer } from "@usine/agents/pi";
import { AttemptChannel } from "@usine/core";
import { Effect, Logger, Stdio, Stream } from "effect";
import { runHost } from "./index.ts";
import { stubLayer } from "./stub.ts";

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
  yield* runHost().pipe(Effect.provide(useStub ? stubLayer(stubDelayMillis) : agentLayer));
}).pipe(Effect.provide(NodeServices.layer), Effect.provideService(Logger.LogToStderr, true));

NodeRuntime.runMain(program);
