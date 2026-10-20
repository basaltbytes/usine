import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import type { WorkerName } from "@usine/core/worker";
import type { ExecutorError, WorkerCapability } from "@usine/executor";
import { Array as Arr, Context, type DateTime, Effect, Layer, Option, Order, Schema } from "effect";

/** A Worker's slots as the scheduler holds them now. */
export interface WorkerSlots {
  readonly worker: WorkerName;
  /** How many Attempts the Worker may run at the same time; zero once a reload removed it. */
  readonly capacity: number;
  /** How many Attempts hold one of its slots, which can exceed `capacity` after a reload lowered it. */
  readonly leased: number;
}

/** A preflight check that found what it verifies ready. */
export interface PreflightPassed {
  readonly _tag: "Passed";
  readonly checkedAt: DateTime.Utc;
}

/** A preflight check that found a prerequisite missing or could not run. */
export interface PreflightFailed {
  readonly _tag: "Failed";
  readonly checkedAt: DateTime.Utc;
  /** The missing prerequisite; none when the check itself failed, such as a timed-out probe. */
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
 * The last preflight of a Worker: its own prerequisites (its machine, Git,
 * memory, Gateway, and credentials), and each harness it was checked with.
 */
export interface WorkerPreflight {
  readonly worker: WorkerName;
  /** None until a preflight decided the Worker's own prerequisites. */
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
 * `previous` after one preflight of `brains` that ended at `checkedAt`,
 * passed when `failure` is none. A passed preflight passes the Worker's own
 * prerequisites and every harness of `brains`. A harness that reported itself
 * unavailable fails, and each harness checked before it passes; the Worker's
 * own record stays as it was, because an exe.dev Worker checks its GitHub
 * integration after its harnesses. Any other failure fails the Worker's own
 * prerequisites and leaves its harnesses as they were.
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

/** A Worker no preflight has checked yet. */
export const unchecked = (worker: WorkerName): WorkerPreflight => ({
  worker,
  prerequisites: Option.none(),
  harnesses: [],
});

/**
 * What the scheduler knows of its Workers now: the slots each one holds and
 * the last preflight of each, so the operator can see capacity and readiness
 * without reading the logs.
 */
export class WorkerStatus extends Context.Service<
  WorkerStatus,
  {
    /**
     * The slots of each Worker that runs Attempts, in `usine.yaml` order, then
     * of each Worker a reload removed, until its last Attempt ends.
     */
    readonly slots: Effect.Effect<ReadonlyArray<WorkerSlots>>;
    /**
     * The last preflight of each Worker checked since startup: the startup
     * preflight, then each preflight of a reload that adds Workers, slots, or
     * brains, including a refused reload's.
     */
    readonly preflights: Effect.Effect<ReadonlyArray<WorkerPreflight>>;
  }
>()("@usine/orchestrator/WorkerStatus") {
  /** No Worker runs Attempts and none was preflighted, as in setup mode. */
  static readonly idle = Layer.succeed(WorkerStatus)({
    slots: Effect.succeed([]),
    preflights: Effect.succeed([]),
  });
}
