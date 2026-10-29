import { Schema } from "effect";
import { RunId } from "../run/run.ts";
import { StepResult } from "./result.ts";

/** The step name from the loop file. After a rename, stored results stay under the old name (ADR 0002). */
export const StepName = Schema.NonEmptyString.pipe(Schema.brand("StepName"));

export type StepName = typeof StepName.Type;

/** A unit of work in a Run, exactly one per Run in v1. `result` is `None` until an Attempt succeeds. */
export class Step extends Schema.Class<Step>("Step")({
  /** The run to which this step belongs. */
  runId: RunId,
  /** The step's identity from the loop definition. */
  name: StepName,
  /** The stored successful result, or `None` until an attempt succeeds. */
  result: Schema.Option(StepResult),
}) {}
