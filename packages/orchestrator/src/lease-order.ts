import type { Lane, LaneName } from "@usine/config/board";
import { canonicalLabelName } from "@usine/config/label";
import type { PriorityValue } from "@usine/config/loop";
import type { WorkerName } from "@usine/core/worker";
import { Array as EffectArray, Option, Order } from "effect";

/** The evaluated priority and lane used to order a queued run. */
export interface PipelinePosition {
  readonly priority: PriorityValue;
  readonly lane: Option.Option<{ readonly name: LaneName; readonly number: number }>;
}

/** Finds the first lane whose label source matches the event's labels, ignoring case. */
export const pipelinePosition = (
  priority: PriorityValue,
  lanes: ReadonlyArray<Lane>,
  labels: ReadonlyArray<string>,
): PipelinePosition => {
  const itemLabels = new Set(labels.map(canonicalLabelName));
  const index = lanes.findIndex(({ sources }) =>
    sources.some((source) => "label" in source && itemLabels.has(canonicalLabelName(source.label))),
  );
  return {
    priority,
    lane: Option.map(Option.fromNullishOr(lanes[index]), (lane) => ({
      name: lane.name,
      number: index + 1,
    })),
  };
};

/** The fields of a queued slot reservation that rank it for a free Worker slot. */
export interface LeaseCandidate {
  /** If set, the only Worker the lease can come from: the Worker of the Run's reattached Attempt. */
  readonly worker: Option.Option<WorkerName>;
  readonly position: PipelinePosition;
  /** When the Run's Event arrived, in epoch milliseconds. */
  readonly eventTime: number;
  /** The order in which the scheduler received the reservation. */
  readonly order: number;
}

const positionOrder = Order.combineAll([
  Order.mapInput(Order.flip(Order.Number), (position: PipelinePosition) => position.priority),
  Order.mapInput(Order.flip(Order.Number), (position: PipelinePosition) =>
    Option.match(position.lane, { onNone: () => 0, onSome: ({ number }) => number }),
  ),
]);

/** Ranks by Event arrival, then by the order in which the scheduler received the reservations. */
const eventOrder: Order.Order<LeaseCandidate> = Order.combineAll([
  Order.mapInput(Order.Number, ({ eventTime }: LeaseCandidate) => eventTime),
  Order.mapInput(Order.Number, ({ order }: LeaseCandidate) => order),
]);

/**
 * Ranks queued reservations for a free Worker slot, so that the Run that advances the
 * furthest-along Item takes it:
 *
 * 1. A reservation that names a Worker, for an Attempt that already runs there (#177).
 * 2. The evaluated priority, higher first, defaulting to zero.
 * 3. The lane rank, later lane first, with unmatched runs last.
 *
 * Event order ranks reservations with the same position.
 */
export const leaseOrder: Order.Order<LeaseCandidate> = Order.combineAll([
  Order.mapInput(Order.Boolean, ({ worker }: LeaseCandidate) => Option.isNone(worker)),
  Order.mapInput(positionOrder, ({ position }: LeaseCandidate) => position),
  eventOrder,
]);

/**
 * Returns the number of `queued` reservations whose Events arrived before the Event of `leased`, the
 * reservation that takes the slot.
 */
export const passedCount = (
  queued: ReadonlyArray<LeaseCandidate>,
  leased: LeaseCandidate,
): number => queued.filter((candidate) => Order.isLessThan(eventOrder)(candidate, leased)).length;

const namingCount = (candidates: ReadonlyArray<LeaseCandidate>, worker: WorkerName): number =>
  candidates.filter((candidate) => Option.contains(candidate.worker, worker)).length;

/**
 * Returns the fewest reservations in `earlier`, the reservations ranked before `waiting` in lease
 * order, that take a Worker slot before `waiting`. `open` lists the Workers that take new Attempts.
 *
 * A reservation that names a Worker takes that Worker's next free slot. A `waiting` that names no
 * Worker comes after every reservation in `earlier` that names none, and after every one that names
 * the Worker in `open` that the fewest reservations name.
 */
export const aheadCount = (
  earlier: ReadonlyArray<LeaseCandidate>,
  waiting: LeaseCandidate,
  open: ReadonlyArray<WorkerName>,
): number =>
  Option.match(waiting.worker, {
    onSome: (worker) => namingCount(earlier, worker),
    onNone: () => {
      const naming = open.map((worker) => namingCount(earlier, worker));
      return (
        earlier.filter(({ worker }) => Option.isNone(worker)).length +
        (EffectArray.isReadonlyArrayNonEmpty(naming) ? EffectArray.min(naming, Order.Number) : 0)
      );
    },
  });
