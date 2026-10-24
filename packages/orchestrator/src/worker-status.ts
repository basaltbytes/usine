import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import type { ItemKey } from "@usine/core/item";
import type { LoopName } from "@usine/core/loop";
import type { RunId } from "@usine/core/run";
import type { WorkerName } from "@usine/core/worker";
import type { ExecutorError, WorkerCapability } from "@usine/executor";
import { Array as Arr, Context, type DateTime, Effect, Layer, Option, Order, Schema } from "effect";
import type { PipelinePosition } from "./lease-order.ts";

/** A Worker's current slot usage in the scheduler. */
export interface WorkerSlots {
  readonly worker: WorkerName;
  /** The maximum concurrent Attempts, or zero after a reload removed the Worker. */
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
}

/** A passed preflight check. */
export interface PreflightPassed {
  readonly _tag: "Passed";
  readonly checkedAt: DateTime.Utc;
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
export type PreflightCheck = PreflightPassed | PreflightFailed;

/** The last preflight of one harness on a Worker. */
export interface HarnessPreflight {
  readonly harness: Harness;
  readonly check: PreflightCheck;
}

/**
 * The last preflight of a Worker: its own prerequisites (machine, Git, memory, Gateway, and
 * credentials) and each checked harness.
 */
export interface WorkerPreflight {
  readonly worker: WorkerName;
  /** `None` until a preflight checked the Worker's own prerequisites. */
  readonly prerequisites: Option.Option<PreflightCheck>;
  /** In harness name order. */
  readonly harnesses: ReadonlyArray<HarnessPreflight>;
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
 * Returns `previous` updated with one preflight of `brains`. An unavailable harness fails that
 * harness and passes the ones checked before it; any other `failure` fails only the prerequisites.
 */
export const recordPreflight = (
  previous: WorkerPreflight,
  brains: ReadonlyArray<BrainSpec>,
  checkedAt: DateTime.Utc,
  failure: Option.Option<ExecutorError>,
): WorkerPreflight => {
  const harnesses = Arr.dedupe(brains.map(({ harness }) => harness));
  if (Option.isNone(failure)) {
    const passed: PreflightCheck = { _tag: "Passed", checkedAt };
    return {
      worker: previous.worker,
      prerequisites: Option.some(passed),
      harnesses: withHarnesses(previous.harnesses, harnesses, passed),
    };
  }
  const error = failure.value;
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
    };
  }
  return {
    worker: previous.worker,
    prerequisites: Option.some(failed),
    harnesses: previous.harnesses,
  };
};

/** Returns the preflight record of a Worker that no preflight has checked. */
export const unchecked = (worker: WorkerName): WorkerPreflight => ({
  worker,
  prerequisites: Option.none(),
  harnesses: [],
});

/** The scheduler's current slot usage, queued Runs, and last preflight of each Worker. */
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
  }
>()("@usine/orchestrator/WorkerStatus") {
  /** A status with no Workers, no queued Runs, and no preflights, as in setup mode. */
  static readonly idle = Layer.succeed(WorkerStatus)({
    slots: Effect.succeed([]),
    queue: Effect.succeed([]),
    preflights: Effect.succeed([]),
  });
}
