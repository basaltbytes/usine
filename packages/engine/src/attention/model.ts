import { OperatorLogin } from "@usine/core/operator";
import { Schema } from "effect";

export const AttentionRevision = Schema.NonEmptyString.pipe(Schema.brand("AttentionRevision"));
export type AttentionRevision = typeof AttentionRevision.Type;

/** The exact content of an attention entry that the operator acknowledged. */
export class AttentionKey extends Schema.Class<AttentionKey>("@usine/engine/AttentionKey")({
  id: Schema.NonEmptyString,
  revision: AttentionRevision,
}) {}

export class AttentionAcknowledgement extends Schema.Class<AttentionAcknowledgement>(
  "@usine/engine/AttentionAcknowledgement",
)({
  ...AttentionKey.fields,
  dismissedBy: Schema.OptionFromNullOr(OperatorLogin),
  dismissedAt: Schema.DateTimeUtcFromString,
}) {}
