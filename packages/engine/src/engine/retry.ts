import { AttemptContext } from "@usine/core/attempt";
import { OperatorActor } from "@usine/core/operator";
import { type Brand, Option, Schema } from "effect";

/**
 * An operator retry of a failed Run. `requestedBy` is `None` if `usine.yaml` sets no operator
 * login, and `amendment` is the edit-and-retry task and Agent (ADR 0018).
 */
export class RetryRequest extends Schema.Class<
  RetryRequest,
  Brand.Brand<"@usine/engine/engine/retry/RetryRequest">
>("@usine/engine/RetryRequest")({
  /** The operator who requested the retry, or `None` when no login was recorded. */
  requestedBy: Schema.Option(OperatorActor),
  /**
   * Replacement task and agent context for this and later attempts, or `None` to keep the
   * effective context (ADR 0018).
   */
  amendment: Schema.Option(AttemptContext),
}) {}

/** A retry without a login that keeps the Run's task and Agent. */
export const plainRetry = RetryRequest.make({
  requestedBy: Option.none(),
  amendment: Option.none(),
});
