import { Schema } from "effect";

/**
 * Returns a JSON key for tuple identities, comparisons, and test fixtures. Preserves input
 * order; callers must supply JSON-serializable values. Throws when a value cannot be encoded.
 */
// oxlint-disable-next-line usine/no-unknown-parameters -- This formatter accepts values from multiple domain schemas; callers own parsing.
export const jsonKey = (value: unknown): string =>
  // Map, Set, and grouping callbacks require synchronous keys without schema transformations.
  // @effect-diagnostics-next-line globalJson:off
  Schema.String.make(JSON.stringify(value));
