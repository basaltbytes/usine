import { OperatorLogin } from "@usine/core/operator";
import { Schema } from "effect";

/**
 * The content revision of an attention entry; a changed revision requires a new dismissal (ADR
 * 0020).
 */
export const AttentionRevision = Schema.NonEmptyString.pipe(Schema.brand("AttentionRevision"));
export type AttentionRevision = typeof AttentionRevision.Type;

/** The exact content of an attention entry that the operator acknowledged. */
export class AttentionKey extends Schema.Class<AttentionKey>("@usine/engine/AttentionKey")({
  /**
   * The stable identity of the attention entry; pair it with `revision` to dismiss its exact
   * content.
   */
  id: Schema.NonEmptyString,
  /** The content revision acknowledged by the operator. */
  revision: AttentionRevision,
}) {}

/**
 * An operator dismissal of one attention entry revision, with the first recorded login and time.
 */
export class AttentionAcknowledgement extends Schema.Class<AttentionAcknowledgement>(
  "@usine/engine/AttentionAcknowledgement",
)({
  ...AttentionKey.fields,
  /** The operator login, or `None` when no login was recorded. */
  dismissedBy: Schema.OptionFromNullOr(OperatorLogin),
  /** The UTC time of the first dismissal for this entry ID and revision. */
  dismissedAt: Schema.DateTimeUtcFromString,
}) {}
