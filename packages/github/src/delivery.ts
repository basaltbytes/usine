import { Schema } from "effect";
import { RepositoryId } from "./installation.ts";

export const WebhookDeliveryId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("WebhookDeliveryId"),
);
export type WebhookDeliveryId = typeof WebhookDeliveryId.Type;

/** The summary fields used to request a repository refresh. */
export class WebhookDelivery extends Schema.Class<WebhookDelivery>("@usine/github/WebhookDelivery")(
  {
    id: WebhookDeliveryId,
    event: Schema.NonEmptyString,
    repositoryId: Schema.OptionFromNullOr(RepositoryId),
  },
) {}

export const WebhookDeliveryFromApi = WebhookDelivery.pipe(
  Schema.encodeKeys({ repositoryId: "repository_id" }),
);
