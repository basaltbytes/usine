import type { ChildHost } from "@usine/agents/child-host";
import type { CredentialRoute, Placement } from "@usine/agents/harness";
import { Harnesses, hostPlacement, ProbeTarget } from "@usine/agents/harness/node";
import { preflight } from "@usine/agents/preflight";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { HarnessReadiness } from "@usine/core/agent/capability";
import type { MachineId, WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Option } from "effect";
import { logPreflightFailure, ExecutorOperationError, WorkerCapabilityError } from "./executor.ts";

/**
 * A function that reports one brain's readiness on a Worker. Only a readiness report indicates a
 * capability gap; transport failures and timeouts are retryable `ExecutorOperationError`s.
 */
export type HarnessProbe = (
  brain: BrainSpec,
  login: Pick<ProbeTarget, "worker" | "machine">,
) => Effect.Effect<HarnessReadiness, ExecutorOperationError | WorkerCapabilityError>;

/**
 * Probes each distinct brain on `worker`, or on its provisioned `machine` if `Some`, and fails with
 * a capability error if a harness is unavailable. Each runtime owns its login synchronization.
 */
export const verifyHarnessReadiness = Effect.fn("Executor.verifyHarnessReadiness")(function* (
  worker: WorkerName,
  machine: Option.Option<MachineId>,
  brains: ReadonlyArray<BrainSpec>,
  probe: HarnessProbe,
) {
  const fields = {
    worker,
    ...Option.match(machine, { onNone: () => ({}), onSome: (id) => ({ machine: id }) }),
  };
  yield* Effect.annotateCurrentSpan(fields);
  const distinct = Arr.dedupe(brains);
  for (const brain of distinct) {
    const result = yield* probe(brain, { worker, machine });
    if (result._tag === "HarnessUnavailableError")
      return yield* WorkerCapabilityError.make({
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
 * child's environment (ADR 0011), over `credential`. `placement` defaults to the host's kind; a
 * sandbox shell passes `sandbox`. A timeout or unreachable host is a retryable infrastructure error.
 */
export const agentsHarnessProbe =
  (
    harnesses: Harnesses["Service"],
    host: ChildHost,
    environment: Readonly<Record<string, string>>,
    credential: CredentialRoute = "host-login",
    placement: Placement = hostPlacement(host),
  ): HarnessProbe =>
  (brain, { worker, machine }) =>
    preflight(
      brain,
      ProbeTarget.make({ host, environment, placement, credential, worker, machine }),
    ).pipe(
      Effect.mapError((cause) =>
        ExecutorOperationError.make({
          operation: "preflight",
          message: cause.message,
          cause,
        }),
      ),
      Effect.provideService(Harnesses, harnesses),
    );
