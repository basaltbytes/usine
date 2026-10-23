import { Schema } from "effect";

/** A provider model name, which the harness checks when the session starts. */
export const ModelId = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank model id" }),
).pipe(Schema.brand("ModelId"));
export type ModelId = typeof ModelId.Type;

export const HARNESSES = ["claude", "codex", "pi"] as const;
export const Harness = Schema.Literals(HARNESSES);
export type Harness = typeof Harness.Type;

/** The reasoning levels; support depends on the harness and model. */
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const Effort = Schema.Literals(EFFORTS);
export type Effort = typeof Effort.Type;

export class BrainSpec extends Schema.Class<BrainSpec>("Agent/BrainSpec")({
  harness: Harness,
  model: ModelId,
  effort: Effort,
}) {}
