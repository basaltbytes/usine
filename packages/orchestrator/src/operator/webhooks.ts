import type { Webhooks } from "@usine/config/factory";
import type { AttentionAcknowledgements } from "@usine/engine/attention";
import { DateTime, Effect } from "effect";
import type { WebhookHealth } from "../webhooks.ts";
import { partitionNeeds } from "./attention.ts";
import { WebhookSilenceNeed } from "./need.ts";
import { ReadyOverview } from "./overview.ts";

export const webhookAttentionFor = (
  health: WebhookHealth["Service"],
  acknowledgements: Pick<AttentionAcknowledgements["Service"], "list">,
) =>
  Effect.fn("Operator.webhookAttention")(function* (overview: ReadyOverview, webhooks: Webhooks) {
    if (webhooks.mode !== "endpoint" || !(yield* health.silent)) return overview;
    const startedAt = DateTime.formatIso(health.startedAt);
    yield* Effect.annotateCurrentSpan({ startedAt });
    yield* Effect.logDebug("Webhook endpoint has received no verified delivery for ten minutes", {
      startedAt,
    });
    const need = new WebhookSilenceNeed({
      id: "webhook-silence",
      startedAt,
      publicUrl: webhooks.publicUrl.href,
    });
    const { needsYou, dismissedNeeds } = partitionNeeds([need], yield* acknowledgements.list());
    return new ReadyOverview({
      ...overview,
      needsYou: [...overview.needsYou, ...needsYou],
      dismissedNeeds: [...overview.dismissedNeeds, ...dismissedNeeds],
    });
  });
