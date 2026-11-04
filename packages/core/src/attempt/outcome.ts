import { type Brand, Schema } from "effect";
import { AttemptFailure } from "./failure.ts";

/** The outcome of a successful Attempt; the step result is stored on the Step. */
export class AttemptSucceeded extends Schema.TaggedClass<
  AttemptSucceeded,
  Brand.Brand<"@usine/core/attempt/outcome/AttemptSucceeded">
>("AttemptOutcome/Succeeded")("Succeeded", {}) {}

/** An unsuccessful attempt with the failure used to decide whether to retry. */
export class AttemptFailed extends Schema.TaggedClass<
  AttemptFailed,
  Brand.Brand<"@usine/core/attempt/outcome/AttemptFailed">
>("AttemptOutcome/Failed")("Failed", {
  /** The recorded failure used to determine whether another attempt may start. */
  failure: AttemptFailure,
}) {}

/** The outcome of an Attempt during which the operator canceled the Run. */
export class AttemptCanceled extends Schema.TaggedClass<
  AttemptCanceled,
  Brand.Brand<"@usine/core/attempt/outcome/AttemptCanceled">
>("AttemptOutcome/Canceled")("Canceled", {}) {}

/** The agent session ended and the pushed head awaits CI. */
export class AttemptAwaitingCi extends Schema.TaggedClass<
  AttemptAwaitingCi,
  Brand.Brand<"@usine/core/attempt/outcome/AttemptAwaitingCi">
>("AttemptOutcome/AwaitingCi")("AwaitingCi", {}) {}

/** The attempt ended and a fix run continues after failed CI. */
export class AttemptHandedOff extends Schema.TaggedClass<
  AttemptHandedOff,
  Brand.Brand<"@usine/core/attempt/outcome/AttemptHandedOff">
>("AttemptOutcome/HandedOff")("HandedOff", {}) {}

/** The outcome of an attempt; a successful step's result is stored separately. */
export const AttemptOutcome = Schema.Union([
  AttemptSucceeded,
  AttemptFailed,
  AttemptCanceled,
  AttemptAwaitingCi,
  AttemptHandedOff,
]);
export type AttemptOutcome = typeof AttemptOutcome.Type;
