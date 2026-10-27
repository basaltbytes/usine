import { Schema } from "effect";

/**
 * Returns `Schema.Struct(fields)` that fails with "Unexpected key" on any key `fields` doesn't
 * declare, whatever `onExcessProperty` the decode site passes.
 */
export const closedStruct = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
): Schema.Struct<Fields> => {
  const struct = Schema.Struct(fields);
  const declared = new Set(Object.keys(fields));
  const undeclared = Schema.Record(
    Schema.String.check(Schema.makeFilter((key) => !declared.has(key))),
    Schema.Never.annotate({ message: "Unexpected key" }),
  );
  return struct.rebuild(Schema.StructWithRest(struct, [undeclared]).ast);
};
