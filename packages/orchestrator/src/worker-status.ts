import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import type { ItemKey } from "@usine/core/item";
import type { LoopName } from "@usine/core/loop";
import type { RunId } from "@usine/core/run";
import type { ContainerLimits, WorkerName } from "@usine/core/worker";
import type {
  ExecutorError,
  MachineStatus,
  MachineUnavailableReason,
  PreflightReport,
  WorkerCapability,
} from "@usine/executor";
import {
  Array as Arr,
  Context,
  type DateTime,
  Effect,
  Layer,
  Option,
  Order,
  Result,
  Schema,
} from "effect";
import type { PipelinePosition } from "./lease-order.ts";

/** A Worker's current slot usage in the scheduler. */
export interface WorkerSlots {
  readonly worker: WorkerName;
  /** The maximum concurrent Attempts, or zero while preflight has failed or after a reload removed the Worker. */
  readonly capacity: number;
  /** The number of Attempts with a slot, which can exceed `capacity` after a reload lowered it. */
  readonly leased: number;
}

/** A Run that waits for a Worker slot. */
export interface QueuedRun {
  readonly runId: RunId;
  readonly loop: LoopName;
  readonly itemKey: ItemKey;
  readonly position: PipelinePosition;
  /**
   * The fewest queued Runs that take a Worker slot before this one. Of the Runs that wait for their
   * reattached Attempt's Worker, a Run that can take any Worker's slot counts only those of the
   * Worker with the fewest, among the Workers that take new Attempts.
   */
  readonly ahead: number;
}

/** A passed preflight check. */
export interface PreflightPassed {
  readonly _tag: "Passed";
  readonly checkedAt: DateTime.Utc;
}

/**
 * A passed check of a Worker's own prerequisites that found it running Attempts without a
 * capability that keeps them apart, such as an SSH Worker without Docker.
 */
export interface PreflightDegraded {
  readonly _tag: "Degraded";
  readonly checkedAt: DateTime.Utc;
  /** The executor's summary for operators. */
  readonly message: string;
}

/**
 * A check that the preflight left for later, such as a provisioned Worker's harness checks,
 * which run on its first machine each day.
 */
export interface PreflightDeferred {
  readonly _tag: "Deferred";
  readonly checkedAt: DateTime.Utc;
  /** When the check runs instead, for operators. */
  readonly message: string;
}

/** A preflight check that found a missing prerequisite or couldn't run. */
export interface PreflightFailed {
  readonly _tag: "Failed";
  readonly checkedAt: DateTime.Utc;
  /** The missing prerequisite, or `None` if the check itself failed, such as a timed-out probe. */
  readonly capability: Option.Option<WorkerCapability>;
  /** The executor's summary for operators. */
  readonly message: string;
}

/** The last outcome of one preflight check and when it ended. */
export type PreflightCheck =
  | PreflightPassed
  | PreflightDegraded
  | PreflightDeferred
  | PreflightFailed;

/**
 * A provisioned Worker that couldn't create a machine, and when it tries again. The Runs it
 * would serve keep waiting.
 */
export interface ProvisioningPause {
  readonly worker: WorkerName;
  /** Why the creation failed, or `check` if the first machine of the day failed its preflight. */
  readonly reason: MachineUnavailableReason | "check";
  readonly message: string;
  /** The number of failed creations in a row. */
  readonly failures: number;
  readonly failedAt: DateTime.Utc;
  readonly retryAt: DateTime.Utc;
  /** Whether the Worker still waits for `retryAt` before it creates a machine. */
  readonly blocked: boolean;
}

/** The last preflight of one harness on a Worker. */
export interface HarnessPreflight {
  readonly harness: Harness;
  readonly check: PreflightCheck;
}

/**
 * The last preflight of a Worker: its own prerequisites (machine, Git, memory, Gateway, and
 * credentials), each checked harness, and the limits of its Attempt containers.
 */
export interface WorkerPreflight {
  readonly worker: WorkerName;
  /** `None` until a preflight checked the Worker's own prerequisites. */
  readonly prerequisites: Option.Option<PreflightCheck>;
  /** In harness name order. */
  readonly harnesses: ReadonlyArray<HarnessPreflight>;
  /**
   * The limits of each Attempt container from the last passed preflight that checked the
   * Worker's machine. `None` before one, or if that machine had no Docker.
   */
  readonly containerLimits: Option.Option<ContainerLimits>;
}

const isHarnessUnavailable = Schema.is(HarnessUnavailableError);

const byHarness = Order.mapInput(Order.String, ({ harness }: HarnessPreflight) => harness);

const withHarnesses = (
  harnesses: ReadonlyArray<HarnessPreflight>,
  checked: ReadonlyArray<Harness>,
  check: PreflightCheck,
): ReadonlyArray<HarnessPreflight> =>
  Arr.sort(
    [
      ...harnesses.filter(({ harness }) => !checked.includes(harness)),
      ...checked.map((harness) => ({ harness, check })),
    ],
    byHarness,
  );

/**
 * Returns `previous` updated with one preflight of `brains`. A degraded report passes every
 * harness and records the prerequisites as degraded, and a deferred report records every
 * harness as deferred and keeps the container limits, since it checked no machine. An
 * unavailable harness fails that harness and passes the ones checked before it; any other
 * failure fails only the prerequisites.
 */
export const recordPreflight = (
  previous: WorkerPreflight,
  brains: ReadonlyArray<BrainSpec>,
  checkedAt: DateTime.Utc,
  outcome: Result.Result<PreflightReport, ExecutorError>,
): WorkerPreflight => {
  const harnesses = Arr.dedupe(brains.map(({ harness }) => harness));
  if (Result.isSuccess(outcome)) {
    const passed: PreflightCheck = { _tag: "Passed", checkedAt };
    return {
      worker: previous.worker,
      prerequisites: Option.some(
        Option.match(outcome.success.degraded, {
          onNone: () => passed,
          onSome: (message): PreflightCheck => ({ _tag: "Degraded", checkedAt, message }),
        }),
      ),
      harnesses: withHarnesses(
        previous.harnesses,
        harnesses,
        Option.match(outcome.success.deferred, {
          onNone: () => passed,
          onSome: (message): PreflightCheck => ({ _tag: "Deferred", checkedAt, message }),
        }),
      ),
      containerLimits: Option.isSome(outcome.success.deferred)
        ? previous.containerLimits
        : outcome.success.containerLimits,
    };
  }
  const error = outcome.failure;
  const capability =
    error._tag === "WorkerCapabilityError" ? Option.some(error.capability) : Option.none();
  const failed: PreflightCheck = { _tag: "Failed", checkedAt, capability, message: error.message };
  if (error._tag === "WorkerCapabilityError" && isHarnessUnavailable(error.cause)) {
    const unavailable = error.cause.harness;
    const before = Arr.dedupe(
      Arr.takeWhile(brains, ({ harness }) => harness !== unavailable).map(({ harness }) => harness),
    );
    return {
      worker: previous.worker,
      prerequisites: previous.prerequisites,
      harnesses: withHarnesses(
        withHarnesses(previous.harnesses, before, { _tag: "Passed", checkedAt }),
        [unavailable],
        failed,
      ),
      containerLimits: previous.containerLimits,
    };
  }
  return {
    worker: previous.worker,
    prerequisites: Option.some(failed),
    harnesses: previous.harnesses,
    containerLimits: previous.containerLimits,
  };
};

/** Returns the preflight record of a Worker that no preflight has checked. */
export const unchecked = (worker: WorkerName): WorkerPreflight => ({
  worker,
  prerequisites: Option.none(),
  harnesses: [],
  containerLimits: Option.none(),
});

/** A worker excluded from scheduling until its startup preflight passes. */
export interface WorkerPreflightFailure {
  readonly worker: WorkerName;
  readonly message: string;
}

/**
 * The scheduler's current slot usage, queued Runs, last preflight of each Worker, and the
 * provisioned Workers' machines and pauses.
 */
export class WorkerStatus extends Context.Service<
  WorkerStatus,
  {
    /**
     * The slots of each Worker in `usine.yaml` order, then of each removed Worker until its last
     * Attempt ends.
     */
    readonly slots: Effect.Effect<ReadonlyArray<WorkerSlots>>;
    /** The Runs that wait for a Worker slot, in the order they take one (`leaseOrder`). */
    readonly queue: Effect.Effect<ReadonlyArray<QueuedRun>>;
    /**
     * The last preflight of each Worker checked since startup, including a refused reload's
     * preflight.
     */
    readonly preflights: Effect.Effect<ReadonlyArray<WorkerPreflight>>;
    /** Startup failures that still prevent scheduling, including the latest retry message. */
    readonly unavailable: Effect.Effect<ReadonlyArray<WorkerPreflightFailure>>;
    /** The machines of the provisioned Workers in flight, oldest first. */
    readonly machines: Effect.Effect<ReadonlyArray<MachineStatus>>;
    /** The provisioned Workers whose last machine creation failed. */
    readonly provisioning: Effect.Effect<ReadonlyArray<ProvisioningPause>>;
  }
>()("@usine/orchestrator/WorkerStatus") {
  /** A status with no Workers, no queued Runs, and no preflights, as in setup mode. */
  static readonly idle = Layer.succeed(WorkerStatus)({
    slots: Effect.succeed([]),
    queue: Effect.succeed([]),
    preflights: Effect.succeed([]),
    unavailable: Effect.succeed([]),
    machines: Effect.succeed([]),
    provisioning: Effect.succeed([]),
  });
}
