import { AttemptId } from "@usine/core/attempt";
import { type Brand, Schema } from "effect";

/**
 * A storage failure of an Attempt's durable record, with the operation that failed. The delegation
 * core, the Pi parent, and the event-driven coordinator report it.
 */
export class JournalError extends Schema.TaggedError<
  JournalError,
  Brand.Brand<"@usine/durable/attempt/journal-error/JournalError">
>("@usine/durable/JournalError")("JournalError", {
  /** What failed, as a verb phrase such as "save the child's conversation". */
  operation: Schema.String,
  attemptId: AttemptId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Could not ${this.operation}: ${cause}`;
  }
}
