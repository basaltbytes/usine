import { Schema } from "effect";
import { AttemptFailure } from "./failure.ts";

/** The attempt finished; the step result is stored on the Step. */
export class AttemptSucceeded extends Schema.TaggedClass<AttemptSucceeded>(
  "AttemptOutcome/Succeeded",
)("Succeeded", {}) {}

/** The attempt failed with the typed failure that closed it. */
export class AttemptFailed extends Schema.TaggedClass<AttemptFailed>("AttemptOutcome/Failed")(
  "Failed",
  {
    failure: AttemptFailure,
  },
) {}

/** The operator canceled the Run during this Attempt. */
export class AttemptCanceled extends Schema.TaggedClass<AttemptCanceled>("AttemptOutcome/Canceled")(
  "Canceled",
  {},
) {}

/** The recorded end of one try; a failed Attempt may still be followed by a retry of the same Step. */
export const AttemptOutcome = Schema.Union([AttemptSucceeded, AttemptFailed, AttemptCanceled]);
export type AttemptOutcome = typeof AttemptOutcome.Type;
