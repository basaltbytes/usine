import { Predicate, Schema } from "effect";

/**
 * The timestamp fields in the payload.ts schemas, excluded from the content hash (ADR 0007).
 * Add each new timestamp field here.
 */
const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set([
  "closedAt",
  "createdAt",
  "mergedAt",
  "submittedAt",
  "updatedAt",
]);

export const canonicalContent = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonicalContent);
  if (Schema.is(Schema.JsonObject)(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, child]) =>
            !TIMESTAMP_FIELDS.has(key) || (!Predicate.isString(child) && child !== null),
        )
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalContent(child)]),
    );
  }
  return value;
};
