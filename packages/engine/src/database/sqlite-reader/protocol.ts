import { Schema } from "effect";

export const Params = Schema.Array(
  Schema.Union([
    Schema.String,
    Schema.Finite,
    Schema.BigInt,
    Schema.Null,
    Schema.declare((input): input is NodeJS.ArrayBufferView => ArrayBuffer.isView(input)),
  ]),
);

export const Command = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Query"),
    session: Schema.NullOr(Schema.Int),
    sql: Schema.String,
    params: Schema.Array(Schema.Unknown),
    values: Schema.Boolean,
    safeIntegers: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("BeginSnapshot") }),
  Schema.Struct({
    _tag: Schema.Literal("EndSnapshot"),
    session: Schema.Int,
    commit: Schema.Boolean,
  }),
]);
export type Command = typeof Command.Type;

export const Request = Schema.Struct({
  id: Schema.Int,
  command: Command,
});

export const Response = Schema.Union([
  Schema.Struct({ id: Schema.Int, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    id: Schema.Int,
    ok: Schema.Literal(false),
    cause: Schema.Struct({ message: Schema.String, errno: Schema.optionalKey(Schema.Finite) }),
  }),
]);
export type Response = typeof Response.Type;
