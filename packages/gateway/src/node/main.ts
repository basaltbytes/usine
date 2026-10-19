#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Logger, Runtime } from "effect";
import { gatewayFromEnvironment } from "./node.ts";

// journald keeps one JSON object per line, which `journalctl -o cat | jq` can filter.
const logger = Logger.layer([Logger.consoleJson]);

NodeRuntime.runMain(
  Layer.launch(gatewayFromEnvironment).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, logger)),
  ),
  {
    // The gateway runs until a signal interrupts it, so systemd records a stop as a success.
    teardown: (exit, onExit) =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? onExit(0)
        : Runtime.defaultTeardown(exit, onExit),
  },
);
