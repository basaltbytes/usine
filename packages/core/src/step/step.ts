import { Schema } from "effect";
import { RunId, StepName } from "../ids.ts";
import { StepResult } from "./result.ts";

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
