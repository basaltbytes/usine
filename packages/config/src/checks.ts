import { Schema } from "effect";

export const nonBlankString = (message: string) =>
  Schema.String.check(Schema.isPattern(/\S/u, { message }));
