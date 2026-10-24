import { AttemptContext } from "@usine/core/attempt";
import { OperatorLogin } from "@usine/core/operator";
import { Option, Schema } from "effect";

/**
 * An operator retry of a failed Run. `requestedBy` is `None` if `usine.yaml` sets no operator
 * login, and `amendment` is the edit-and-retry task and Agent (ADR 0018).
 */
export class RetryRequest extends Schema.Class<RetryRequest>("@usine/engine/RetryRequest")({
  requestedBy: Schema.Option(OperatorLogin),
  amendment: Schema.Option(AttemptContext),
}) {}

/** A retry without a login that keeps the Run's task and Agent. */
export const plainRetry = new RetryRequest({
  requestedBy: Option.none(),
  amendment: Option.none(),
});
