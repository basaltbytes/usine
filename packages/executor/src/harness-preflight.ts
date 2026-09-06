import { BrainSpec } from "@usine/core/agent/brain";
import { HarnessReadiness } from "@usine/core/agent/capability";
import type { WorkerName } from "@usine/core/worker";
import { Effect, Schema } from "effect";
import {
  logPreflightFailure,
  type ExecutorOperationError,
  type RunHostCommand,
  WorkerCapabilityError,
} from "./executor.ts";

/** Uses the installed run host so both adapters check the same worker-side harness contract. */
export const verifyHarnesses = Effect.fn("Executor.verifyHarnesses")(function* (
  worker: WorkerName,
  brains: ReadonlyArray<BrainSpec>,
  runHost: RunHostCommand,
  execute: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ExecutorOperationError>,
) {
  yield* Effect.annotateCurrentSpan({ worker });
  const distinct = new Map(brains.map((brain) => [JSON.stringify(brain), brain]));
  for (const brain of distinct.values()) {
    const response = yield* execute(runHost.command, [
      ...runHost.args,
      "--preflight",
      Schema.encodeSync(Schema.fromJsonString(BrainSpec))(brain),
    ]).pipe(
      Effect.timeout("75 seconds"),
      Effect.mapError(
        (cause) =>
          new WorkerCapabilityError({
            worker,
            capability: "run-host",
            message: `Worker ${worker} could not probe ${brain.harness} readiness`,
            cause,
          }),
      ),
    );
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HarnessReadiness))(
      response,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () =>
          new WorkerCapabilityError({
            worker,
            capability: "run-host",
            message: `Worker ${worker} returned an invalid harness preflight response; update its run host`,
            cause: new Error("invalid harness readiness response"),
          }),
      ),
    );
    if (result.harness !== brain.harness)
      return yield* new WorkerCapabilityError({
        worker,
        capability: "run-host",
        message: `Worker ${worker} returned readiness for the wrong harness`,
        cause: new Error("harness readiness mismatch"),
      });
    if (result._tag === "HarnessUnavailableError")
      return yield* new WorkerCapabilityError({
        worker,
        capability: result.capability === "login" ? "harness-login" : "toolchain",
        message: result.message,
        cause: result,
      });
    yield* Effect.logInfo("Worker harness preflight verified", {
      worker,
      harness: brain.harness,
      model: brain.model,
    });
  }
  if (distinct.size === 0) yield* Effect.logDebug("No rostered harnesses to preflight", { worker });
}, logPreflightFailure);
