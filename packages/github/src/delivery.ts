import { Schema } from "effect";
import { RepositoryId } from "./installation.ts";

/** GitHub's positive delivery ID as decimal digits. Compare IDs with `BigInt` (ADR 0014). */
export const WebhookDeliveryId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)).pipe(
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

export const WebhookDeliveriesFromJson = Schema.fromJsonString(
  Schema.Array(WebhookDelivery.pipe(Schema.encodeKeys({ repositoryId: "repository_id" }))),
  {
    // Node 22's reviver source preserves the digits before numeric rounding.
    reviver: (key: string, value: Schema.Json, context?: { readonly source?: string }) =>
      key === "id" ? context?.source : value,
  },
);
