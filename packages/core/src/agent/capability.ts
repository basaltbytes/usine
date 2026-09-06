import { Schema } from "effect";
import { Harness } from "./brain.ts";

/** A harness prerequisite that requires operator provisioning, never an automatic retry. */
export const HarnessCapability = Schema.Literals(["binary", "version", "login"]);
export type HarnessCapability = typeof HarnessCapability.Type;

/** The Worker cannot run the requested harness until the operator fixes its provisioning. */
export class HarnessUnavailableError extends Schema.TaggedError<HarnessUnavailableError>(
  "HarnessUnavailableError",
)("HarnessUnavailableError", {
  harness: Harness,
  capability: HarnessCapability,
  message: Schema.NonEmptyString,
}) {}

/** A verify-only probe found the requested harness available in the Worker's environment. */
export class HarnessReady extends Schema.TaggedClass<HarnessReady>("HarnessReady")("HarnessReady", {
  harness: Harness,
}) {}

/** The run host's preflight response; contains no credentials or account identity. */
export const HarnessReadiness = Schema.Union([HarnessReady, HarnessUnavailableError]);
export type HarnessReadiness = typeof HarnessReadiness.Type;
