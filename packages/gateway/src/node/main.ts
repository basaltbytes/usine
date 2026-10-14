#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { gatewayFromEnvironment } from "./node.ts";

// journald keeps one JSON object per line, which `journalctl -o cat | jq` can filter.
const logger = Logger.layer([Logger.consoleJson]);

NodeRuntime.runMain(
  Layer.launch(gatewayFromEnvironment).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, logger)),
  ),
);
