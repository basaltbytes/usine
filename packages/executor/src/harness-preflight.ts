import type { ChildHost } from "@usine/agents/child-host";
import { preflight } from "@usine/agents/preflight";
import type { ClaudeLoginLock } from "@usine/agents/runtime";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { HarnessReadiness } from "@usine/core/agent/capability";
import type { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { logPreflightFailure, ExecutorOperationError, WorkerCapabilityError } from "./executor.ts";

/**
 * Reports one rostered brain's readiness on a Worker. Only a readiness report
 * proves a capability gap; transport failures and timeouts stay retryable
 * infrastructure errors.
 */
export type HarnessProbe = (
  brain: BrainSpec,
) => Effect.Effect<HarnessReadiness, ExecutorOperationError | WorkerCapabilityError>;

/**
 * Checks each distinct brain through `probe` and turns an unavailable harness
 * into a capability error. A Claude check holds `worker`'s lock in `logins`
 * until it returns, so two Attempts preparing on one Worker never refresh its
 * Claude login at the same time, nor while a Claude child starts there (#453).
 */
export const verifyHarnessReadiness = Effect.fn("Executor.verifyHarnessReadiness")(function* (
  worker: WorkerName,
  brains: ReadonlyArray<BrainSpec>,
  probe: HarnessProbe,
  logins: ClaudeLoginLock["Service"],
) {
  yield* Effect.annotateCurrentSpan({ worker });
  const distinct = Arr.dedupe(brains);
  for (const brain of distinct) {
    const result = yield* brain.harness === "claude"
      ? Effect.logDebug("Checking Claude under the Worker's Claude login lock", {
          worker,
          model: brain.model,
        }).pipe(Effect.andThen(logins.withLock(worker)(probe(brain))))
      : probe(brain);
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

/**
 * Checks one brain where `host` runs children, with the `@usine/agents/preflight`
 * checks and `environment` as a child of the Worker would see it, never the
 * orchestrator's own (ADR 0011). A timed-out or unreachable probe stays a
 * retryable infrastructure error.
 */
export const agentsHarnessProbe =
  (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    host: ChildHost,
    environment: Readonly<Record<string, string>>,
  ): HarnessProbe =>
  (brain) =>
    preflight(brain, host, environment).pipe(
      Effect.map((ready): HarnessReadiness => ready),
      Effect.catchTag("HarnessUnavailableError", (unavailable) => Effect.succeed(unavailable)),
      Effect.mapError(
        (cause) =>
          new ExecutorOperationError({
            operation: "preflight",
            message: cause.message,
            cause,
          }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
