import { Schema } from "effect";
import { RepositoryId } from "./installation.ts";

/** GitHub's positive delivery ID, used as the cursor for newer webhook summaries (ADR 0014). */
export const WebhookDeliveryId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("WebhookDeliveryId"),
);
export type WebhookDeliveryId = typeof WebhookDeliveryId.Type;

/** The summary fields used to request a repository refresh. */
export class WebhookDelivery extends Schema.Class<WebhookDelivery>("@usine/github/WebhookDelivery")(
  {
    /** The delivery ID; retain the greatest processed ID as the cursor for the next summary read. */
    id: WebhookDeliveryId,
    /** The GitHub webhook event name, such as `issues` or `push`; no delivery payload is included. */
    event: Schema.NonEmptyString,
    /** The repository to refresh, or `None` for deliveries without a repository, such as a ping. */
    repositoryId: Schema.OptionFromNullOr(RepositoryId),
  },
) {}

export const WebhookDeliveryFromApi = WebhookDelivery.pipe(
  Schema.encodeKeys({ repositoryId: "repository_id" }),
);
