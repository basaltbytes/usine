#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Logger, Runtime } from "effect";
import { gatewayFromEnvironment } from "./node.ts";

// One JSON object per line, so `journalctl -o cat | jq` can filter journald output.
const logger = Logger.layer([Logger.consoleJson]);

NodeRuntime.runMain(
  Layer.launch(gatewayFromEnvironment).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, logger)),
  ),
  {
    // The Gateway runs until a signal interrupts it, so systemd records the stop as a success.
    teardown: (exit, onExit) =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? onExit(0)
        : Runtime.defaultTeardown(exit, onExit),
  },
);
