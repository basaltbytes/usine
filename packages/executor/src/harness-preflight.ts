import type { ChildHost } from "@usine/agents/child-host";
import { preflight } from "@usine/agents/preflight";
import type { ClaudeLoginLock } from "@usine/agents/runtime";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { HarnessReadiness } from "@usine/core/agent/capability";
import type { MachineId, WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { logPreflightFailure, ExecutorOperationError, WorkerCapabilityError } from "./executor.ts";

/**
 * A function that reports one brain's readiness on a Worker. Only a readiness report indicates a
 * capability gap; transport failures and timeouts are retryable `ExecutorOperationError`s.
 */
export type HarnessProbe = (
  brain: BrainSpec,
) => Effect.Effect<HarnessReadiness, ExecutorOperationError | WorkerCapabilityError>;

/**
 * Probes each distinct brain on `worker`, or on its provisioned `machine` if `Some`, and fails with
 * a capability error if a harness is unavailable. A Claude probe holds that login's lock in
 * `logins`, so two preparations never refresh one Claude login concurrently or while a Claude
 * child starts (#453).
 */
export const verifyHarnessReadiness = Effect.fn("Executor.verifyHarnessReadiness")(function* (
  worker: WorkerName,
  machine: Option.Option<MachineId>,
  brains: ReadonlyArray<BrainSpec>,
  probe: HarnessProbe,
  logins: ClaudeLoginLock["Service"],
) {
  const fields = {
    worker,
    ...Option.match(machine, { onNone: () => ({}), onSome: (id) => ({ machine: id }) }),
  };
  yield* Effect.annotateCurrentSpan(fields);
  const distinct = Arr.dedupe(brains);
  for (const brain of distinct) {
    const result = yield* brain.harness === "claude"
      ? Effect.logDebug("Checking Claude under its Claude login lock", {
          ...fields,
          model: brain.model,
        }).pipe(Effect.andThen(logins.withLock(worker, machine)(probe(brain))))
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
 * Returns a probe that checks one brain where `host` runs children, with `environment` as the
 * child's environment (ADR 0011). A timeout or unreachable host is a retryable infrastructure
 * error.
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
