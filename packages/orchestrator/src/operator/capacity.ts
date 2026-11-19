import type { AttentionAcknowledgements } from "@usine/engine/attention";
import { capacityGroupKey, type CapacityWait } from "@usine/engine/engine";
import { DateTime, Effect } from "effect";
import { partitionNeeds } from "./attention.ts";
import { ProviderCapacityNeed } from "./need.ts";
import { ReadyOverview } from "./overview.ts";

/** Returns one attention entry for each capacity group at capacity, in place of a failure per Run. */
export const capacityNeeds = (
  waits: ReadonlyArray<CapacityWait>,
): ReadonlyArray<ProviderCapacityNeed> =>
  waits.map(({ group, message, since, nextTryAt, probes, runIds }) =>
    ProviderCapacityNeed.make({
      id: `provider-capacity:${capacityGroupKey(group)}`,
      group,
      message,
      since: DateTime.formatIso(since),
      nextTryAt: DateTime.formatIso(nextTryAt),
      waitingRuns: new Set([...probes, ...runIds]).size,
    }),
  );

export const capacityAttentionFor = (
  read: Effect.Effect<ReadonlyArray<CapacityWait>>,
  acknowledgements: Pick<AttentionAcknowledgements["Service"], "list">,
) =>
  Effect.fn("Operator.capacityAttention")(function* (overview: ReadyOverview) {
    const waits = yield* read;
    yield* Effect.annotateCurrentSpan({ groups: waits.length });
    if (waits.length === 0) return overview;
    const needs = capacityNeeds(waits);
    yield* Effect.logDebug("Refreshed the attention entries of capacity groups at capacity", {
      groups: needs.map(({ id, waitingRuns, nextTryAt }) => ({ id, waitingRuns, nextTryAt })),
    });
    const storedAcknowledgements = yield* acknowledgements.list;
    const { needsYou, dismissedNeeds } = partitionNeeds(needs, storedAcknowledgements);
    return ReadyOverview.make({
      ...overview,
      needsYou: [...overview.needsYou, ...needsYou],
      dismissedNeeds: [...overview.dismissedNeeds, ...dismissedNeeds],
    });
  });
