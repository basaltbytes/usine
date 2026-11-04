import { type Brand, Schema } from "effect";
import { CommitSha } from "../repository.ts";

export const MAX_STEP_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_STEP_OUTPUTS = 10;

/** The file-name slug, without the `.json` extension. */
export const StepOutputName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u),
).pipe(Schema.brand("StepOutputName"));
export type StepOutputName = typeof StepOutputName.Type;

/** An opaque, non-empty type of at most 128 UTF-16 code units supplied by the agent. */
export const StepOutputType = Schema.NonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("StepOutputType"),
);
export type StepOutputType = typeof StepOutputType.Type;

/** The SHA-256 of the UTF-8 JSON encoding of `content`. */
export const StepOutputSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(
  Schema.brand("StepOutputSha256"),
);
export type StepOutputSha256 = typeof StepOutputSha256.Type;

/** Output metadata retained in run reads and exports. */
export class StepOutputRef extends Schema.Class<
  StepOutputRef,
  Brand.Brand<"@usine/core/step/output/StepOutputRef">
>("StepOutputRef")({
  name: StepOutputName,
  type: StepOutputType,
  commit: Schema.OptionFromOptionalKey(CommitSha),
  /** The uncompressed UTF-8 byte count of the JSON content. */
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: StepOutputSha256,
}) {}

/** A JSON document collected from an attempt's checkout. */
export class StepOutput extends StepOutputRef.extend<StepOutput>("StepOutput")({
  content: Schema.Json,
}) {
  get ref(): StepOutputRef {
    return StepOutputRef.make({
      name: this.name,
      type: this.type,
      commit: this.commit,
      size: this.size,
      sha256: this.sha256,
    });
  }
}
