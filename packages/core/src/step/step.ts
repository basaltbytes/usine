import { Schema } from "effect";
import { RunId } from "../run/run.ts";
import { StepResult } from "./result.ts";

/**
 * Step identity within its run — the loop-authored name (ADR 0002). Renaming a
 * step in the loop file retires it — prior results stay under the old name.
 * There is deliberately no synthetic step id.
 */
export const StepName = Schema.NonEmptyString.pipe(Schema.brand("StepName"));

export type StepName = typeof StepName.Type;

/**
 * Ledger row: a named unit of work inside a run, its stored result addressable
 * by name; exactly one per run in v1 (the agent action). The result is the run
 * host's final message, stored when an attempt succeeds — none until then.
 */
export class Step extends Schema.Class<Step>("Step")({
  runId: RunId,
  name: StepName,
  result: Schema.Option(StepResult),
}) {}
