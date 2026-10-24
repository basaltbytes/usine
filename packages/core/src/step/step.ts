import { Schema } from "effect";
import { RunId } from "../run/run.ts";
import { StepResult } from "./result.ts";

/** The step name from the loop file. After a rename, stored results stay under the old name (ADR 0002). */
export const StepName = Schema.NonEmptyString.pipe(Schema.brand("StepName"));

export type StepName = typeof StepName.Type;

/** A unit of work in a Run, exactly one per Run in v1. `result` is `None` until an Attempt succeeds. */
export class Step extends Schema.Class<Step>("Step")({
  runId: RunId,
  name: StepName,
  result: Schema.Option(StepResult),
}) {}
