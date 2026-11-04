import { type Brand, Schema } from "effect";

/** A provider model name, which the harness checks when the session starts. */
export const ModelId = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Expected a non-blank model ID" }),
).pipe(Schema.brand("ModelId"));
export type ModelId = typeof ModelId.Type;

/** A coding-agent CLI ID. Configuration validates membership in the harness catalog. */
export const Harness = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case harness ID",
  }),
).pipe(Schema.brand("Harness"));
export type Harness = typeof Harness.Type;

/** The reasoning levels; support depends on the harness and model. */
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** The requested reasoning level; the selected harness and model determine which levels are supported. */
export const Effort = Schema.Literals(EFFORTS);
export type Effort = typeof Effort.Type;

/** The harness, model, and reasoning effort selected for an agent session. */
export class BrainSpec extends Schema.Class<
  BrainSpec,
  Brand.Brand<"@usine/core/agent/brain/BrainSpec">
>("Agent/BrainSpec")({
  /** The coding-agent CLI that runs the session. */
  harness: Harness,
  /** The provider model name checked by the harness at startup. */
  model: ModelId,
  /** The reasoning level requested from the selected harness and model. */
  effort: Effort,
}) {}
