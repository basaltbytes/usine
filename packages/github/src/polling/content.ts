import { Schema } from "effect";

/**
 * Timestamp fields in the payload schemas in payload.ts. Add each new timestamp
 * field here so changes to it remain outside the content hash (ADR 0007).
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
        .filter(([key]) => !TIMESTAMP_FIELDS.has(key))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalContent(child)]),
    );
  }
  return value;
};
