import { Schema } from "effect";
import { RunId } from "../run/run.ts";
import { StepResult } from "./result.ts";

/**
 * The loop-authored step name. Renaming a step in the loop file retires it and
 * its stored results stay under the old name (ADR 0002).
 */
export const StepName = Schema.NonEmptyString.pipe(Schema.brand("StepName"));

export type StepName = typeof StepName.Type;

/**
 * A named unit of work inside a run, exactly one per run in v1. The result is
 * stored when an attempt succeeds and is none until then.
 */
export class Step extends Schema.Class<Step>("Step")({
  runId: RunId,
  name: StepName,
  result: Schema.Option(StepResult),
}) {}
