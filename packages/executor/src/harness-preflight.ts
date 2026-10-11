import { BrainSpec } from "@usine/core/agent/brain";
import { HarnessReadiness } from "@usine/core/agent/capability";
import type { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Schema } from "effect";
import {
  logPreflightFailure,
  ExecutorOperationError,
  type RunHostCommand,
  WorkerCapabilityError,
} from "./executor.ts";

/**
 * Reports one rostered brain's readiness on a Worker. Only a readiness report
 * proves a capability gap; transport failures and timeouts stay retryable
 * infrastructure errors.
 */
export type HarnessProbe = (
  brain: BrainSpec,
) => Effect.Effect<HarnessReadiness, ExecutorOperationError | WorkerCapabilityError>;

/** Checks each distinct brain through `probe` and turns an unavailable harness into a capability error. */
export const verifyHarnessReadiness = Effect.fn("Executor.verifyHarnessReadiness")(function* (
  worker: WorkerName,
  brains: ReadonlyArray<BrainSpec>,
  probe: HarnessProbe,
) {
  yield* Effect.annotateCurrentSpan({ worker });
  const distinct = Arr.dedupe(brains);
  for (const brain of distinct) {
    const result = yield* probe(brain);
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
  if (distinct.length === 0)
    yield* Effect.logDebug("No rostered harnesses to preflight", { worker });
}, logPreflightFailure);

/** Uses the installed run host so both adapters check the same worker-side harness contract. */
export const verifyHarnesses = (
  worker: WorkerName,
  brains: ReadonlyArray<BrainSpec>,
  runHost: RunHostCommand,
  execute: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ExecutorOperationError>,
) =>
  verifyHarnessReadiness(
    worker,
    brains,
    Effect.fn("Executor.probeRunHostHarness")(function* (brain: BrainSpec) {
      yield* Effect.annotateCurrentSpan({ worker, harness: brain.harness });
      const response = yield* execute(runHost.command, [
        ...runHost.args,
        "--preflight",
        Schema.encodeSync(Schema.fromJsonString(BrainSpec))(brain),
      ]).pipe(
        Effect.timeout("75 seconds"),
        Effect.catchTag(
          "TimeoutError",
          (cause) =>
            new ExecutorOperationError({
              operation: "preflight",
              message: `Worker ${worker} did not finish probing ${brain.harness} readiness`,
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
      return result;
    }),
  );
