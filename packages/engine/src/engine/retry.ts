import { AttemptContext } from "@usine/core/attempt";
import { OperatorLogin } from "@usine/core/operator";
import { Option, Schema } from "effect";

/**
 * The operator's retry of a failed Run: the login that asked, none while
 * `usine.yaml` names no operator, and the task and Agent an edit-and-retry
 * gives the Run's later Attempts (ADR 0018). The next Attempt records both.
 */
export class RetryRequest extends Schema.Class<RetryRequest>("@usine/engine/RetryRequest")({
  requestedBy: Schema.Option(OperatorLogin),
  amendment: Schema.Option(AttemptContext),
}) {}

/** A retry from no recorded login that keeps the Run's task and Agent. */
export const plainRetry = new RetryRequest({
  requestedBy: Option.none(),
  amendment: Option.none(),
});
