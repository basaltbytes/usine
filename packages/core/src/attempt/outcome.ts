import { Schema } from "effect";
import { AttemptFailure } from "./failure.ts";

/** The outcome of a successful Attempt; the step result is stored on the Step. */
export class AttemptSucceeded extends Schema.TaggedClass<AttemptSucceeded>(
  "AttemptOutcome/Succeeded",
)("Succeeded", {}) {}

export class AttemptFailed extends Schema.TaggedClass<AttemptFailed>("AttemptOutcome/Failed")(
  "Failed",
  {
    failure: AttemptFailure,
  },
) {}

/** The outcome of an Attempt during which the operator canceled the Run. */
export class AttemptCanceled extends Schema.TaggedClass<AttemptCanceled>("AttemptOutcome/Canceled")(
  "Canceled",
  {},
) {}

export const AttemptOutcome = Schema.Union([AttemptSucceeded, AttemptFailed, AttemptCanceled]);
export type AttemptOutcome = typeof AttemptOutcome.Type;
