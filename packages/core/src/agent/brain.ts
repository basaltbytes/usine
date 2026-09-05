import { Schema } from "effect";

/** A provider's model name; the selected harness checks its availability when the session starts. */
export const ModelId = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank model id" }),
).pipe(Schema.brand("ModelId"));
export type ModelId = typeof ModelId.Type;

/** Coding runtimes an Agent can select for delegated work. */
export const HARNESSES = ["claude", "codex", "pi"] as const;
/** The coding runtime that executes an Agent session. */
export const Harness = Schema.Literals(HARNESSES);
export type Harness = typeof Harness.Type;

/** Reasoning levels accepted in Agent files; support depends on the chosen harness and model. */
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** The requested amount of reasoning for a session; available levels depend on its harness and model. */
export const Effort = Schema.Literals(EFFORTS);
export type Effort = typeof Effort.Type;

/** How an Agent session runs: its coding harness, model, and reasoning effort. */
export class BrainSpec extends Schema.Class<BrainSpec>("Agent/BrainSpec")({
  harness: Harness,
  model: ModelId,
  effort: Effort,
}) {}
