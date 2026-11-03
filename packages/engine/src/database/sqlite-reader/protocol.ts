import { Schema } from "effect";

export const Params = Schema.Array(
  Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.BigInt,
    Schema.Null,
    Schema.declare((input): input is NodeJS.ArrayBufferView => ArrayBuffer.isView(input)),
  ]),
);

export const Request = Schema.Struct({
  id: Schema.Int,
  sql: Schema.String,
  params: Schema.Array(Schema.Unknown),
  values: Schema.Boolean,
  safeIntegers: Schema.Boolean,
});

export const Response = Schema.Union([
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    id: Schema.Int,
    ok: Schema.Literal(false),
    cause: Schema.Struct({ message: Schema.String, errno: Schema.optionalKey(Schema.Number) }),
  }),
]);
export type Response = typeof Response.Type;
