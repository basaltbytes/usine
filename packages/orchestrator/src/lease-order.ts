import type { Lane, LaneName } from "@usine/config/board";
import { canonicalLabelName } from "@usine/config/label";
import type { LoopPriority } from "@usine/config/loop";
import type { WorkerName } from "@usine/core/worker";
import { Match, Option, Order } from "effect";

/** Where a queued Run's Item is in the pipeline, which ranks the Run for a free Worker slot. */
export type PipelinePosition =
  | { readonly _tag: "Priority"; readonly priority: LoopPriority }
  | {
      readonly _tag: "Lane";
      readonly lane: LaneName;
      /** The lane's place in the repository's `lanes`, counting from 1. */
      readonly number: number;
    }
  | { readonly _tag: "Unpositioned" };

/**
 * Returns the position of a Run: its Loop's `priority`, else the first of the repository's `lanes`
 * with a label source among the Item `labels` in the Run's Event, compared ignoring case as GitHub
 * does. While the Run runs, the Board keeps its card in that lane unless the Item's current labels
 * match a lane.
 */
export const pipelinePosition = (
  priority: Option.Option<LoopPriority>,
  lanes: ReadonlyArray<Lane>,
  labels: ReadonlyArray<string>,
): PipelinePosition => {
  if (Option.isSome(priority)) return { _tag: "Priority", priority: priority.value };
  const itemLabels = new Set(labels.map(canonicalLabelName));
  const index = lanes.findIndex(({ sources }) =>
    sources.some((source) => "label" in source && itemLabels.has(canonicalLabelName(source.label))),
  );
  const lane = lanes[index];
  return lane === undefined
    ? { _tag: "Unpositioned" }
    : { _tag: "Lane", lane: lane.name, number: index + 1 };
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

const TIERS = {
  Priority: 0,
  Lane: 1,
  Unpositioned: 2,
} as const satisfies Record<PipelinePosition["_tag"], number>;

const rankInTier = (position: PipelinePosition): number =>
  Match.valueTags(position, {
    Priority: ({ priority }) => priority,
    Lane: ({ number }) => number,
    Unpositioned: () => 0,
  });

const positionOrder = Order.combineAll([
  Order.mapInput(Order.Number, (position: PipelinePosition) => TIERS[position._tag]),
  Order.mapInput(Order.flip(Order.Number), rankInTier),
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
 * 2. A Run of a Loop with a `priority`, higher first.
 * 3. A Run positioned by lane, later lane first.
 * 4. Any other Run.
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
