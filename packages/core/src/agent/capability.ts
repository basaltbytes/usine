import { Schema } from "effect";
import { Harness } from "./brain.ts";

/** A harness prerequisite that the operator must provision; a missing one is never retried. */
export const HarnessCapability = Schema.Literals(["binary", "version", "login"]);
export type HarnessCapability = typeof HarnessCapability.Type;

/** An error for a Worker that is missing `capability` for `harness`. */
export class HarnessUnavailableError extends Schema.TaggedError<HarnessUnavailableError>(
  "HarnessUnavailableError",
)("HarnessUnavailableError", {
  harness: Harness,
  capability: HarnessCapability,
  message: Schema.NonEmptyString,
}) {}

/** The result of a verify-only probe that found the harness available on the Worker. */
export class HarnessReady extends Schema.TaggedClass<HarnessReady>("HarnessReady")("HarnessReady", {
  harness: Harness,
}) {}

/** The result of a harness preflight, without credentials or account identity. */
export const HarnessReadiness = Schema.Union([HarnessReady, HarnessUnavailableError]);
export type HarnessReadiness = typeof HarnessReadiness.Type;
